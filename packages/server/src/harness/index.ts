/**
 * The harness registry — one place that knows which runtimes exist.
 *
 * Harnesses are singletons per process because they hold expensive shared
 * state: Claude caches its model catalogue, Codex owns a ref-counted app-server
 * process. Handing out a fresh instance per chat would spawn a second app
 * server and re-probe the catalogue on every send.
 *
 * Only Claude is compiled in. Codex and goose are built-in PLUGINS
 * (`packages/plugins/`) that register through `ctx.providers` while the server
 * starts, before the port opens — see `PluginService.activateShipped`.
 *
 * `resolve` never throws for an unknown or unavailable kind — it falls back to
 * Claude and says so. A project whose harness was uninstalled must still open,
 * because the alternative is a project the user cannot get into to change the
 * setting.
 */
import {
  BUILTIN_HARNESS_KINDS,
  DEFAULT_HARNESS,
  registerProvider,
  unregisterProvider,
  type BuiltinHarnessKind,
  type HarnessKind,
  type ProviderDescriptor,
} from "@dispatch/shared";
import type { Harness, HarnessRuntimeInfo } from "./types.js";
import { ClaudeHarness } from "./claude/index.js";

export * from "./types.js";
export { ClaudeHarness, CLAUDE_CAPABILITIES, parseClaudeLimitHit } from "./claude/index.js";

export interface HarnessRegistryOpts {
  /** Injectable built-in harnesses (tests, and the E2E fake SDK). */
  harnesses?: Partial<Record<BuiltinHarnessKind, Harness>>;
  /**
   * Providers to register up front, as a plugin would — for tests that drive a
   * fake Codex or goose without loading the plugin host.
   */
  providers?: Array<{ harness: Harness; descriptor: ProviderDescriptor }>;
}

/**
 * How to build each BUILT-IN provider's runtime adapter — the server half of
 * registering one (the shared half is `BUILTIN_PROVIDERS`). Typed as a full
 * record so a new built-in fails to compile until it has an adapter here. Any
 * other provider goes through {@link HarnessRegistry.register}.
 */
const HARNESS_FACTORIES: Record<BuiltinHarnessKind, () => Harness> = {
  claude: () => new ClaudeHarness(),
};

export class HarnessRegistry {
  private readonly map = new Map<HarnessKind, Harness>();

  constructor(opts: HarnessRegistryOpts = {}) {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      this.map.set(kind, opts.harnesses?.[kind] ?? HARNESS_FACTORIES[kind]());
    }
    for (const { harness, descriptor } of opts.providers ?? []) this.register(harness, descriptor);
  }

  /**
   * Add a provider that is not compiled into the host, with the descriptor the
   * rest of the app labels it by.
   *
   * Refuses an id that is already taken. Replacing a live harness would leave
   * every running session on the old adapter while new ones start on the new
   * one, and a plugin that shadowed `claude` would silently take over the
   * fallback every unavailable provider resolves to.
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
   * turn running at the moment of the toggle errors. The next start of one of
   * its chats falls back to Claude.
   */
  async unregister(kind: HarnessKind): Promise<void> {
    if ((BUILTIN_HARNESS_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`cannot unregister built-in provider "${kind}"`);
    }
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
   * The harness to actually run a chat on.
   *
   * Falls back to the default rather than throwing, so an uninstalled runtime
   * degrades to "this chat runs on Claude" instead of an unopenable project.
   * The caller is told what happened via `fellBack` so the UI can say so.
   */
  resolve(kind: HarnessKind | undefined): { harness: Harness; fellBack: boolean } {
    const wanted = this.find(kind);
    if (wanted && wanted.runtime().available) return { harness: wanted, fellBack: false };
    const fallback = this.map.get(DEFAULT_HARNESS)!;
    return { harness: fallback, fellBack: Boolean(kind) && kind !== DEFAULT_HARNESS };
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
