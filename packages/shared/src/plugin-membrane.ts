/**
 * The membrane between two plugins — what stands between a consumer and the
 * API a provider serves it (`ctx.dependencies.get` / `ctx.provides.serve`).
 *
 * Plugins run in-process, so nothing here is a sandbox. What it guarantees:
 *
 *   NEVER STALE. Once the pair is revoked (either side went down), the
 *   export's TOP-LEVEL methods throw `PluginRevokedError`, so the consumer
 *   learns at its entry points. Every OTHER function that crossed — a
 *   callback either way, a method on an object a call returned, a listener
 *   core passed through — becomes INERT: it does nothing and returns
 *   `undefined`. Throwing there would land in code that never expected it
 *   (core's `attach()` wires a handle's `on` with no try/catch; a throw
 *   inside the provider's own `emit`, called from a socket's `close`
 *   handler, is an uncaught exception). What those functions controlled was
 *   already ended by the provider's own teardown, which runs before the
 *   revocation.
 *
 *   NO LATE DELIVERY. A call in flight when the pair is revoked rejects with
 *   `PluginRevokedError` when it settles, and its result is dropped: a shell
 *   spawned mid-disable is never handed over half-dead. The provider ends
 *   what it made through `caller.signal`.
 *
 *   BLAME LANDS RIGHT. A throw crossing becomes a `PluginCallError` naming the
 *   plugin whose code threw (the provider for its methods, the consumer for
 *   its callbacks), with the original message and stack — and NOTHING else.
 *   No `cause`, no non-Error payload: whatever a plugin threw must not ride
 *   into the crash log, which serialises what it is given, and key material
 *   crosses this boundary.
 *
 * What it wraps: functions, and plain objects and arrays (prototype
 * `Object.prototype` / `null`, or an array) up to {@link MEMBRANE_MAX_DEPTH}
 * levels deep, in both directions. Class instances, streams, Buffers, typed
 * arrays, Dates, Maps and AbortSignals pass through UNWRAPPED: a Proxy over a
 * Node stream breaks its brand checks, `pipe` and `#private` fields. A
 * contract that needs something revocable makes it a plain object of
 * functions. The membrane never logs, serialises or stores what crosses it.
 *
 * One implementation for the host and the SDK's fake, so a plugin's tests
 * see the same behaviour production does.
 */

import type { HostAbortSignal } from "./harness.js";
import type { PluginCaller, PluginExportFactory } from "./plugin-api.js";
import type { PluginCapability } from "./plugin-manifest.js";

/** How far into plain data the membrane looks for functions to wrap. */
export const MEMBRANE_MAX_DEPTH = 4;

/** The pair is gone: one of the two plugins went down. `code: "revoked"`. */
export class PluginRevokedError extends Error {
  readonly code = "revoked";
  constructor(
    /** The plugin whose API (or callback) was withdrawn. */
    readonly plugin: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginRevokedError";
  }
}

/** Something one plugin's code threw while the other was calling it. */
export class PluginCallError extends Error {
  /** The plugin whose code threw. */
  readonly plugin: string;
  /** The export it happened under, `machines@1`. */
  readonly export: string;
  /** The thrower's own `code`, when it set a string one — what contracts match on (`instanceof` fails across bundles). */
  readonly code?: string;
  constructor(init: { plugin: string; export: string; message: string; code?: string }) {
    super(init.message);
    this.name = "PluginCallError";
    this.plugin = init.plugin;
    this.export = init.export;
    if (init.code !== undefined) this.code = init.code;
  }
}

/** One side of a pair, as errors and revocations name it. */
export interface MembraneParty {
  id: string;
  name: string;
}

export interface PluginMembraneOptions {
  provider: MembraneParty;
  caller: MembraneParty;
  /** The export the pair is about, `machines@1`. */
  export: string;
}

export interface PluginMembrane {
  /** The provider's API object as the caller gets it. Its own (and inherited) methods are the TOP-LEVEL ones. */
  wrapApi<T extends object>(api: T): T;
  /**
   * Withdraw the pair. `reason` is the sentence a top-level call then throws
   * ("Remote host is no longer active"). Idempotent; never undone.
   */
  revoke(reason?: string): void;
  readonly revoked: boolean;
  /** A throw from `side`'s code, as the other side should see it. Exposed for the factory call. */
  translate(err: unknown, side: "provider" | "caller"): Error;
}

type Side = "provider" | "caller";

const isPlain = (v: unknown): v is Record<PropertyKey, unknown> => {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

/** `PluginCallError` / `PluginRevokedError`, recognised by shape too, so one from another copy of this module passes through untouched. */
function alreadyTagged(err: unknown): err is PluginCallError | PluginRevokedError {
  if (err instanceof PluginCallError || err instanceof PluginRevokedError) return true;
  const e = err as { name?: unknown; plugin?: unknown } | null;
  return !!e && typeof e === "object" && (e.name === "PluginCallError" || e.name === "PluginRevokedError") && typeof e.plugin === "string";
}

export function createPluginMembrane(o: PluginMembraneOptions): PluginMembrane {
  let revoked = false;
  let reason = `the ${o.export} link between ${o.caller.id} and ${o.provider.id} was withdrawn`;
  const other = (s: Side): Side => (s === "provider" ? "caller" : "provider");
  const party = (s: Side) => (s === "provider" ? o.provider : o.caller);

  /** Every wrapper this membrane made → the original and whose it is, so a value going home is unwrapped, not double-wrapped. */
  const originals = new WeakMap<object, { original: object; side: Side }>();
  /** Stable identities: the same original crossing the same way yields the same wrapper. */
  const fnCache: Record<Side, WeakMap<object, object>> = { provider: new WeakMap(), caller: new WeakMap() };
  const objCache: Record<Side, WeakMap<object, object>> = { provider: new WeakMap(), caller: new WeakMap() };

  const revokedError = () => new PluginRevokedError(o.provider.id, reason);

  function translate(err: unknown, side: Side): Error {
    if (alreadyTagged(err)) return err as Error;
    const who = party(side);
    if (err instanceof Error) {
      const raw = (err as { code?: unknown }).code;
      const code = typeof raw === "string" ? raw : undefined;
      const out = new PluginCallError({ plugin: who.id, export: o.export, message: `${who.name}: ${err.message}`, ...(code ? { code } : {}) });
      // The thrower's frames, under the new first line; the original object is not kept.
      if (typeof err.stack === "string") out.stack = `PluginCallError: ${out.message}\n${err.stack.split("\n").slice(1).join("\n")}`;
      return out;
    }
    return new PluginCallError({
      plugin: who.id,
      export: o.export,
      message: `${who.name} threw a non-Error (${err === null ? "null" : typeof err})`,
    });
  }

  /** A value owned by `from` crossing to the other side. */
  function wrap(value: unknown, from: Side, depth: number): unknown {
    if (typeof value === "function") return wrapFn(value as (...a: unknown[]) => unknown, from, false);
    if (value === null || typeof value !== "object") return value;
    const home = originals.get(value);
    if (home) return home.side === other(from) ? home.original : value;
    if (depth >= MEMBRANE_MAX_DEPTH) return value;
    if (value instanceof Promise) return settle(value, from);
    if (isPlain(value)) return wrapObj(value, from, depth);
    return value;
  }

  /** A promise owned by `from`: its value crosses when it settles — unless the pair was revoked meanwhile. */
  function settle(p: PromiseLike<unknown>, from: Side): Promise<unknown> {
    const out = Promise.resolve(p).then(
      (v) => {
        if (revoked) throw revokedError();
        return wrap(v, from, 0);
      },
      (err: unknown) => {
        if (revoked) throw revokedError();
        throw translate(err, from);
      },
    );
    // Marked handled: a promise nobody awaits (an async callback whose result
    // the provider ignores) that settles after revocation would otherwise turn
    // a RESOLVED original into an unhandledRejection, which the server treats
    // as a crash. Whoever does await it still gets the rejection.
    out.catch(() => {});
    return out;
  }

  /**
   * A function owned by `from`. `top` marks the API object's own methods,
   * which throw once revoked; every other wrapper goes inert. `self`, when
   * given, is the `this` it runs with — the unwrapped owner object, so
   * `#private` fields and closures over `this` keep working.
   */
  function wrapFn(fn: (...a: unknown[]) => unknown, from: Side, top: boolean, self?: object): (...a: unknown[]) => unknown {
    const home = originals.get(fn);
    if (home) return home.side === other(from) ? (home.original as typeof fn) : fn;
    const cache = !top && !self ? fnCache[from] : undefined;
    const hit = cache?.get(fn);
    if (hit) return hit as typeof fn;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      if (revoked) {
        if (top) throw revokedError();
        return undefined;
      }
      const into = args.map((a) => wrap(a, other(from), 0));
      const thisArg = self ?? (this !== null && typeof this === "object" ? (originals.get(this)?.original ?? this) : this);
      let out: unknown;
      try {
        out = Reflect.apply(fn, thisArg, into);
      } catch (err) {
        throw translate(err, from);
      }
      if (isThenable(out)) return settle(out, from);
      return wrap(out, from, 0);
    };
    Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
    originals.set(wrapper, { original: fn, side: from });
    cache?.set(fn, wrapper);
    return wrapper;
  }

  /**
   * A plain object or array owned by `from`, as a Proxy over an empty shadow
   * of the same kind — reads go to the original live (a label the provider
   * changes later reads changed), its OWN function properties come back
   * wrapped, nested plain values recursively. The shadow keeps Proxy
   * invariants out of the way: a frozen original would forbid handing back a
   * wrapper for one of its properties.
   */
  function wrapObj(obj: Record<PropertyKey, unknown>, from: Side, depth: number, root = false): object {
    const cache = root ? undefined : objCache[from];
    const hit = cache?.get(obj);
    if (hit) return hit;
    const memo = new Map<PropertyKey, { raw: unknown; wrapped: unknown }>();
    const read = (key: PropertyKey): unknown => {
      const raw = Reflect.get(obj, key);
      const own = Object.hasOwn(obj, key);
      // Inherited functions (Array.prototype's, Object.prototype's) are left
      // alone: called with the proxy as `this`, they read through the traps.
      // On the ROOT, inherited methods are the API (a class instance).
      const fnHere = typeof raw === "function" && (own || (root && !isBuiltinMethod(raw)));
      if (!fnHere && !(own && raw !== null && typeof raw === "object")) return raw;
      const m = memo.get(key);
      if (m && m.raw === raw) return m.wrapped;
      const wrapped = fnHere ? wrapFn(raw as (...a: unknown[]) => unknown, from, root, obj) : wrap(raw, from, depth + 1);
      memo.set(key, { raw, wrapped });
      return wrapped;
    };
    const shadow: object = Array.isArray(obj) ? [] : Object.create(null);
    const proxy = new Proxy(shadow, {
      get: (_t, key) => read(key),
      set: (_t, key, value) => Reflect.set(obj, key, wrap(value, other(from), depth + 1)),
      has: (_t, key) => Reflect.has(obj, key),
      deleteProperty: (_t, key) => Reflect.deleteProperty(obj, key),
      ownKeys: () => Reflect.ownKeys(obj),
      getOwnPropertyDescriptor: (t, key) => {
        const d = Reflect.getOwnPropertyDescriptor(obj, key);
        if (!d) return undefined;
        if ("value" in d) d.value = read(key);
        // Only a property the SHADOW holds as non-configurable may be reported
        // as such (an array's `length`); everything else is configurable.
        const sd = Reflect.getOwnPropertyDescriptor(t, key);
        d.configurable = sd ? sd.configurable : true;
        return d;
      },
      defineProperty: (_t, key, d) => Reflect.defineProperty(obj, key, d),
      getPrototypeOf: () => Object.getPrototypeOf(obj),
    });
    originals.set(proxy, { original: obj, side: from });
    cache?.set(obj, proxy);
    return proxy;
  }

  return {
    wrapApi<T extends object>(api: T): T {
      if (typeof api === "function") return wrapFn(api as (...a: unknown[]) => unknown, "provider", true) as unknown as T;
      return wrapObj(api as Record<PropertyKey, unknown>, "provider", 0, true) as T;
    },
    revoke(why?: string) {
      if (why) reason = why;
      revoked = true;
    },
    get revoked() {
      return revoked;
    },
    translate,
  };
}

/** The methods every object has (`toString`, `hasOwnProperty`…) — never part of an API. */
const OBJECT_METHODS: ReadonlySet<unknown> = new Set(
  Object.getOwnPropertyNames(Object.prototype)
    .map((k) => Object.getOwnPropertyDescriptor(Object.prototype, k)?.value)
    .filter((v) => typeof v === "function"),
);
const isBuiltinMethod = (fn: unknown): boolean => OBJECT_METHODS.has(fn);

/** The consumer's side of a link, as core knows it — from its validated manifest and grant. */
export interface PluginLinkCaller extends MembraneParty {
  version: string;
  capabilities: readonly PluginCapability[];
}

export interface OpenPluginLinkOptions {
  provider: MembraneParty;
  caller: PluginLinkCaller;
  /** `machines@1`. */
  export: string;
  /** What the provider's factory serves this export with. */
  factory: PluginExportFactory;
  /** Becomes `caller.signal`. The host (or the SDK's fake) owns its controller and aborts it when the link closes. */
  signal: HostAbortSignal;
}

/**
 * Open one consumer's link to one export: build the `PluginCaller` the
 * provider's factory is handed, run the factory, check what it returned, and
 * wrap it in a fresh membrane. The host and the SDK's fake both open links
 * through this, so a plugin's tests and production cannot disagree on what a
 * caller looks like or what a factory may return.
 *
 * Throws a `PluginCallError` blamed on the provider when the factory throws
 * or hands back something that is not an API object (a promise included:
 * `get` is synchronous, and a promise of an API would leave the consumer
 * holding something no membrane can revoke).
 */
export function openPluginLink(o: OpenPluginLinkOptions): { api: unknown; membrane: PluginMembrane } {
  const membrane = createPluginMembrane({ provider: o.provider, caller: o.caller, export: o.export });
  const caller: PluginCaller = Object.freeze({
    id: o.caller.id,
    name: o.caller.name,
    version: o.caller.version,
    capabilities: Object.freeze([...o.caller.capabilities]),
    signal: o.signal,
  });
  let api: unknown;
  try {
    api = o.factory(caller);
  } catch (err) {
    throw membrane.translate(err, "provider");
  }
  if (api === null || (typeof api !== "object" && typeof api !== "function") || isThenable(api)) {
    throw new PluginCallError({
      plugin: o.provider.id,
      export: o.export,
      message: `${o.provider.name}: the ${o.export} factory must return the API object, synchronously`,
    });
  }
  return { api: membrane.wrapApi(api), membrane };
}

/**
 * The sentence a closed link's API throws, for the side that went down. The
 * consumer reads it at its entry points, so it names what is gone in words.
 */
export function pluginLinkClosedReason(down: "provider" | "caller", provider: MembraneParty, caller: MembraneParty): string {
  return down === "provider"
    ? `${provider.name} is no longer running`
    : `${caller.name} is no longer running, and its link to ${provider.name} is closed`;
}
