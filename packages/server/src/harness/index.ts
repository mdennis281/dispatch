/**
 * The harness registry — one place that knows which runtimes exist.
 *
 * Harnesses are singletons per process because they hold expensive shared
 * state: Claude caches its model catalogue, Codex owns a ref-counted app-server
 * process. Handing out a fresh instance per chat would spawn a second app
 * server and re-probe the catalogue on every send.
 *
 * NOTHING is compiled in. Claude, Codex and goose are all built-in PLUGINS
 * (`packages/plugins/`) that register through `ctx.providers` while the server
 * starts, before the port opens — see `PluginService.activateShipped`. Claude
 * was the last to leave (#428); until then it was constructed here, which put
 * the Agent SDK in every install whether or not anyone used Claude.
 *
 * `resolve` never throws for an unknown or unavailable kind — and never
 * substitutes another provider either. It answers `{ ok: false, unavailable }`
 * and the caller shows that state. It used to fall back to Claude, and the
 * broker then rewrote the chat's `harness` to Claude for good: disabling a
 * plugin for a minute permanently moved every one of its chats (#426).
 */
import {
  providerAvailability,
  registerProvider,
  unregisterProvider,
  type HarnessKind,
  type ProviderDescriptor,
  type ProviderUnavailable,
} from "@dispatch/shared";
import type { Harness, HarnessRuntimeInfo } from "./types.js";

export * from "./types.js";

/**
 * What {@link HarnessRegistry.resolve} answers: the harness to run on, or why
 * there is none. No third arm — there is no fallback provider.
 */
export type HarnessResolution =
  | { ok: true; harness: Harness }
  | { ok: false; unavailable: ProviderUnavailable };

/**
 * A turn, chat or switch refused because the provider cannot run it. Thrown by
 * the broker and `createChat`; routes answer it 409 with
 * `{ error, code: "provider-unavailable", provider, reason }`, and the WS
 * dispatcher publishes it as an `error` event carrying the same `code`.
 */
export class ProviderUnavailableError extends Error {
  readonly code = "provider-unavailable" as const;
  constructor(readonly unavailable: ProviderUnavailable) {
    super(unavailable.message);
    this.name = "ProviderUnavailableError";
  }
}

/** The 409 body a route answers a {@link ProviderUnavailableError} with. */
export function providerUnavailableBody(err: ProviderUnavailableError): {
  error: string;
  code: "provider-unavailable";
  provider?: HarnessKind;
  reason: ProviderUnavailable["reason"];
} {
  const { message, provider, reason } = err.unavailable;
  return { error: message, code: err.code, ...(provider ? { provider } : {}), reason };
}

export interface HarnessRegistryOpts {
  /**
   * Providers to register up front, as a plugin would — for tests that drive a
   * provider without loading the plugin host. A fresh registry is EMPTY: an
   * install whose provider plugins are all off has no provider at all.
   */
  providers?: Array<{ harness: Harness; descriptor: ProviderDescriptor }>;
}

export class HarnessRegistry {
  private readonly map = new Map<HarnessKind, Harness>();

  constructor(opts: HarnessRegistryOpts = {}) {
    for (const { harness, descriptor } of opts.providers ?? []) this.register(harness, descriptor);
  }

  /**
   * Add a provider, with the descriptor the rest of the app labels it by.
   *
   * Refuses an id that is already taken. Replacing a live harness would leave
   * every running session on the old adapter while new ones start on the new
   * one.
   */
  register(harness: Harness, descriptor: ProviderDescriptor): void {
    if (harness.kind !== descriptor.id) {
      throw new Error(`harness kind "${harness.kind}" does not match descriptor id "${descriptor.id}"`);
    }
    if (this.map.has(harness.kind)) throw new Error(`provider "${harness.kind}" is already registered`);
    registerProvider(descriptor);
    this.map.set(harness.kind, harness);
  }

  /**
   * Drop a registered provider and release its runtime — its plugin was
   * switched off. `dispose()` is the harness's to define, and it may end
   * sessions in flight: Codex's tears down its shared app-server, so a Codex
   * turn running at the moment of the toggle errors. Its chats then show
   * "provider unavailable" until the plugin is enabled again — they are never
   * moved to another provider.
   */
  async unregister(kind: HarnessKind): Promise<void> {
    const harness = this.map.get(kind);
    if (!harness) return;
    this.map.delete(kind);
    unregisterProvider(kind);
    await harness.dispose?.();
  }

  /** Every registered harness, for the settings pane and the boot log. */
  list(): Harness[] {
    return [...this.map.values()];
  }

  /** The harness for a kind, or undefined when the kind is unknown. */
  find(kind: HarnessKind | undefined): Harness | undefined {
    return kind ? this.map.get(kind) : undefined;
  }

  /**
   * The harness to actually run a chat on, or why it cannot run.
   *
   * Registered AND reporting its runtime available, or nothing: the judgement
   * is `providerAvailability`, shared with the client so the composer never
   * offers Send for a turn this would refuse. A pure lookup — cheap enough to
   * call on every turn start, which is what lets a chat recover by itself the
   * moment its plugin is re-enabled.
   */
  resolve(kind: HarnessKind | undefined): HarnessResolution {
    const wanted = this.find(kind);
    // Only the wanted harness is probed: `runtime()` can stat a binary, and
    // the other providers have no bearing on whether THIS chat can run.
    const unavailable = providerAvailability(
      kind,
      wanted ? [{ kind: wanted.kind, runtime: wanted.runtime() }] : [],
    );
    if (unavailable || !wanted) return { ok: false, unavailable: unavailable! };
    return { ok: true, harness: wanted };
  }

  /** Runtime resolution for every harness, for the boot log. */
  runtimes(): HarnessRuntimeInfo[] {
    return this.list().map((h) => h.runtime());
  }

  /** Release every shared runtime (process teardown). */
  async dispose(): Promise<void> {
    for (const h of this.map.values()) await h.dispose?.();
  }
}
