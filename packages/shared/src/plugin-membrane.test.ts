import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPluginMembrane, MEMBRANE_MAX_DEPTH, PluginCallError, PluginRevokedError } from "./plugin-membrane.js";

const membrane = () =>
  createPluginMembrane({
    provider: { id: "remote-host", name: "Remote host" },
    caller: { id: "proxmox-terminal", name: "Proxmox terminal" },
    export: "machines@1",
  });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("createPluginMembrane — revocation", () => {
  it("after revoke, the API's own methods throw PluginRevokedError naming the provider and the reason", () => {
    const m = membrane();
    const api = m.wrapApi({ ping: () => "pong" });
    expect(api.ping()).toBe("pong");
    m.revoke("Remote host is no longer active");
    expect(m.revoked).toBe(true);
    let caught: unknown;
    try {
      api.ping();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginRevokedError);
    expect(caught).toMatchObject({ code: "revoked", plugin: "remote-host", message: "Remote host is no longer active" });
  });

  it("everything else that crossed goes INERT — no throw, returns undefined, never reaches the owner", () => {
    const m = membrane();
    const kill = vi.fn(() => "killed");
    const api = m.wrapApi({ spawn: () => ({ kill, nested: { deep: () => 1 } }) });
    const handle = api.spawn();
    let listener: ((x: number) => void) | undefined;
    const provider = m.wrapApi({ subscribe: (fn: (x: number) => void) => void (listener = fn) });
    const seen = vi.fn();
    provider.subscribe(seen);
    m.revoke();
    // A function inside a result — core calling a stale handle's kill.
    expect(handle.kill()).toBeUndefined();
    expect(handle.nested.deep()).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    // A callback the consumer passed in — the provider's emit after revocation.
    expect(() => listener!(1)).not.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it("a call in flight when the pair is revoked rejects with PluginRevokedError, and its result is never handed over", async () => {
    const m = membrane();
    let resolve!: (v: unknown) => void;
    const shell = { kill: vi.fn() };
    const api = m.wrapApi({ spawn: () => new Promise((r) => (resolve = r)) });
    const pending = api.spawn();
    m.revoke("Remote host is no longer active");
    resolve(shell);
    const err = await rejection(pending);
    expect(err).toBeInstanceOf(PluginRevokedError);
  });

  it("a late rejection is also reported as revoked, not as the provider's error", async () => {
    const m = membrane();
    let reject!: (e: unknown) => void;
    const api = m.wrapApi({ spawn: () => new Promise((_r, j) => (reject = j)) });
    const pending = api.spawn();
    m.revoke();
    reject(new Error("socket closed"));
    expect(await rejection(pending)).toBeInstanceOf(PluginRevokedError);
  });

  it("a promise nobody awaits that settles after revocation is not an unhandled rejection", async () => {
    const m = membrane();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let resolve!: () => void;
      // The consumer's async callback; the provider fires it and ignores the result.
      let cb!: () => unknown;
      const api = m.wrapApi({ on: (fn: () => unknown) => void (cb = fn) });
      api.on(() => new Promise<void>((r) => (resolve = r)));
      cb();
      m.revoke();
      resolve();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("data properties stay readable after revoke — the registry reads id and label while unregistering", () => {
    const m = membrane();
    const api = m.wrapApi({ backend: () => ({ id: "proxmox", label: "Proxmox", meta: { region: "g" }, spawn: () => 1 }) });
    const b = api.backend();
    m.revoke();
    expect(b.id).toBe("proxmox");
    expect(b.label).toBe("Proxmox");
    expect(b.meta.region).toBe("g");
    expect(Object.keys(b)).toEqual(["id", "label", "meta", "spawn"]);
  });

  it("revoke is idempotent and the first reason given is kept unless a later one is supplied", () => {
    const m = membrane();
    const api = m.wrapApi({ f: () => 1 });
    m.revoke("first");
    m.revoke();
    expect(() => api.f()).toThrow("first");
  });
});

describe("createPluginMembrane — errors", () => {
  it("a provider throw becomes a PluginCallError tagged with the provider — message prefixed, code kept, stack kept, no cause", () => {
    const m = membrane();
    const original = Object.assign(new Error("no route to host", { cause: { secret: "KEY" } }), { code: "unreachable", extra: "KEY" });
    const api = m.wrapApi({
      connect: () => {
        throw original;
      },
    });
    let caught: PluginCallError | undefined;
    try {
      api.connect();
    } catch (err) {
      caught = err as PluginCallError;
    }
    expect(caught).toBeInstanceOf(PluginCallError);
    expect(caught).toMatchObject({ plugin: "remote-host", export: "machines@1", code: "unreachable", message: "Remote host: no route to host" });
    expect(caught!.cause).toBeUndefined();
    expect((caught as unknown as { extra?: unknown }).extra).toBeUndefined();
    expect(caught).not.toBe(original);
    expect(caught!.stack).toContain("PluginCallError: Remote host: no route to host");
    // The thrower's frames survive, under the new first line.
    expect(caught!.stack!.split("\n").length).toBeGreaterThan(1);
  });

  it("a rejected promise from the provider is translated the same way", async () => {
    const m = membrane();
    const api = m.wrapApi({ spawn: async () => Promise.reject(Object.assign(new Error("busy"), { code: "busy" })) });
    const err = await rejection(api.spawn());
    expect(err).toBeInstanceOf(PluginCallError);
    expect(err).toMatchObject({ plugin: "remote-host", code: "busy", message: "Remote host: busy" });
  });

  it("a callback's throw is blamed on the CONSUMER", () => {
    const m = membrane();
    let caught: unknown;
    const api = m.wrapApi({
      each: (fn: () => void) => {
        try {
          fn();
        } catch (err) {
          caught = err;
        }
      },
    });
    api.each(() => {
      throw new Error("bad listener");
    });
    expect(caught).toBeInstanceOf(PluginCallError);
    expect(caught).toMatchObject({ plugin: "proxmox-terminal", message: "Proxmox terminal: bad listener" });
  });

  it("a non-Error throwable never crosses — not its value, not its shape", () => {
    const m = membrane();
    const api = m.wrapApi({
      a: () => {
        throw { password: "hunter2" };
      },
      b: () => {
        throw "a string with KEY in it";
      },
      c: () => {
        throw null;
      },
    });
    const msg = (f: () => unknown) => {
      try {
        f();
      } catch (err) {
        expect(err).toBeInstanceOf(PluginCallError);
        expect(JSON.stringify(err)).not.toMatch(/hunter2|KEY/);
        return (err as Error).message;
      }
      return "";
    };
    expect(msg(() => api.a())).toBe("Remote host threw a non-Error (object)");
    expect(msg(() => api.b())).toBe("Remote host threw a non-Error (string)");
    expect(msg(() => api.c())).toBe("Remote host threw a non-Error (null)");
  });

  it("an already-tagged error passes through as it is, so a chain of membranes does not re-prefix it", () => {
    const inner = membrane();
    const innerApi = inner.wrapApi({
      f: () => {
        throw new Error("deep");
      },
    });
    const outer = createPluginMembrane({ provider: { id: "b", name: "B" }, caller: { id: "c", name: "C" }, export: "x@1" });
    const outerApi = outer.wrapApi({ g: () => innerApi.f() });
    expect(() => outerApi.g()).toThrow("Remote host: deep");
  });

  it("nothing is logged while crossing — not the arguments, not the errors", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      const m = membrane();
      const api = m.wrapApi({
        auth: (key: string) => {
          throw new Error(`refused ${key.length} bytes`);
        },
        later: async (key: string) => key,
      });
      expect(() => api.auth("-----BEGIN KEY-----")).toThrow();
      await api.later("-----BEGIN KEY-----");
      m.revoke();
      expect(() => api.auth("x")).toThrow(PluginRevokedError);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("createPluginMembrane — what is wrapped and what is not", () => {
  it("methods run against the UNWRAPPED owner: `this` and #private fields work, and sync stays sync", () => {
    class Machines {
      #count = 0;
      bump(): number {
        this.#count++;
        return this.#count;
      }
      agentNote(): string {
        return `n=${this.#count}`;
      }
    }
    const m = membrane();
    const api = m.wrapApi(new Machines());
    expect(api.bump()).toBe(1);
    expect(api.bump()).toBe(2);
    expect(api.agentNote()).toBe("n=2");
    expect(api instanceof Machines).toBe(true);
    m.revoke();
    // A class's methods are its API: they throw, like an object literal's.
    expect(() => api.bump()).toThrow(PluginRevokedError);
  });

  it("a method on a nested plain object keeps that object as `this`", () => {
    const m = membrane();
    const api = m.wrapApi({
      make: () => ({
        n: 41,
        next() {
          return this.n + 1;
        },
      }),
    });
    expect(api.make().next()).toBe(42);
  });

  it("streams, Buffers, Dates, Maps, AbortSignals, class instances and Errors pass through untouched", () => {
    const m = membrane();
    const stream = new PassThrough();
    const buf = Buffer.from("x");
    const date = new Date(0);
    const map = new Map([[1, 2]]);
    const signal = new AbortController().signal;
    const emitter = new EventEmitter();
    const err = new Error("as a value");
    const api = m.wrapApi({ things: () => ({ stream, buf, date, map, signal, emitter, err }) });
    const t = api.things();
    expect(t.stream).toBe(stream);
    expect(t.buf).toBe(buf);
    expect(t.date).toBe(date);
    expect(t.map).toBe(map);
    expect(t.signal).toBe(signal);
    expect(t.emitter).toBe(emitter);
    expect(t.err).toBe(err);
    // And they still work: `pipe` brand checks hold on the real object.
    const sink = new PassThrough();
    t.stream.pipe(sink);
    stream.write("hi");
    expect(sink.read()?.toString()).toBe("hi");
  });

  it("a stream's listener is NOT revocable — the contract must not hand one over expecting it to be", () => {
    const m = membrane();
    const stdout = new PassThrough();
    const api = m.wrapApi({ handle: () => ({ stdout }) });
    const seen = vi.fn();
    api.handle().stdout.on("data", seen);
    m.revoke();
    stdout.write("after");
    expect(seen).toHaveBeenCalled();
  });

  it("arrays are wrapped element-wise and still look like arrays", () => {
    const m = membrane();
    const fns = [() => "a", () => "b"];
    const api = m.wrapApi({ list: () => fns });
    const got = api.list();
    expect(Array.isArray(got)).toBe(true);
    expect(got.length).toBe(2);
    expect(got.map((f) => f())).toEqual(["a", "b"]);
    m.revoke();
    expect(got[0]!()).toBeUndefined();
  });

  it(`looks ${MEMBRANE_MAX_DEPTH} levels into plain data and no further`, () => {
    const m = membrane();
    const deep = vi.fn(() => "reached");
    // Level 0 is the result; the function sits on the object at level MAX.
    let v: Record<string, unknown> = { f: deep };
    for (let i = 0; i < MEMBRANE_MAX_DEPTH; i++) v = { n: v };
    const api = m.wrapApi({ get: () => v });
    let got: Record<string, unknown> = api.get();
    for (let i = 0; i < MEMBRANE_MAX_DEPTH; i++) got = got.n as Record<string, unknown>;
    m.revoke();
    // Past the depth, the function is the original: not revocable.
    expect((got.f as () => string)()).toBe("reached");
  });

  it("the same value crossing twice is the same wrapper, and a wrapper going home is unwrapped", () => {
    const m = membrane();
    let held: unknown;
    const cb = () => 1;
    const api = m.wrapApi({
      keep: (fn: unknown) => void (held = fn),
      isSame: (fn: unknown) => fn === held,
      give: () => held,
      obj: () => shared,
    });
    const shared = { x: () => 1 };
    api.keep(cb);
    // The provider sees one stable wrapper for one consumer function…
    expect(api.isSame(cb)).toBe(true);
    // …and the consumer gets ITS function back, not a wrapper of a wrapper.
    expect(api.give()).toBe(cb);
    expect(api.obj()).toBe(api.obj());
  });

  it("an object handed back to its owner is the owner's object", () => {
    const m = membrane();
    const record = { id: "m1", touch: () => 1 };
    const api = m.wrapApi({ lease: () => record, owns: (r: unknown) => r === record });
    expect(api.owns(api.lease())).toBe(true);
  });

  it("reads are live — a label the provider changes later reads changed", () => {
    const m = membrane();
    const backend = { label: "starting" };
    const api = m.wrapApi({ b: () => backend });
    const b = api.b();
    backend.label = "ready";
    expect(b.label).toBe("ready");
  });

  it("a frozen result can still be wrapped (the shadow target keeps proxy invariants out of the way)", () => {
    const m = membrane();
    const frozen = Object.freeze({ id: "x", run: () => 7 });
    const api = m.wrapApi({ f: () => frozen });
    const got = api.f();
    expect(got.run()).toBe(7);
    expect(Object.getOwnPropertyDescriptor(got, "id")?.value).toBe("x");
    expect(JSON.stringify(got)).toBe('{"id":"x"}');
  });

  it("functions keep their names", () => {
    const m = membrane();
    function spawn() {
      return 1;
    }
    const api = m.wrapApi({ spawn });
    expect(api.spawn.name).toBe("spawn");
  });

  it("a callable export — a function as the API — is a top-level method", () => {
    const m = membrane();
    const api = m.wrapApi((x: number) => x + 1);
    expect(api(1)).toBe(2);
    m.revoke();
    expect(() => api(1)).toThrow(PluginRevokedError);
  });

  it("Object.prototype methods on the root are left alone, not treated as API", () => {
    const m = membrane();
    const api = m.wrapApi({ a: 1 });
    m.revoke();
    expect(api.hasOwnProperty("a")).toBe(true);
    expect(String(api)).toBe("[object Object]");
  });
});
