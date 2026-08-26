/**
 * The harness registry — one place that knows which runtimes exist.
 *
 * Harnesses are singletons per process because both hold expensive shared
 * state: Claude caches its model catalogue, Codex owns a ref-counted app-server
 * process. Handing out a fresh instance per chat would spawn a second app
 * server and re-probe the catalogue on every send.
 *
 * `resolveHarness` never throws for an unknown or unavailable kind — it falls
 * back to Claude and says so. A project whose harness was uninstalled must
 * still open, because the alternative is a project the user cannot get into to
 * change the setting.
 */
import { DEFAULT_HARNESS, type HarnessKind } from "@dispatch/shared";
import type { Harness, HarnessRuntimeInfo } from "./types.js";
import { ClaudeHarness } from "./claude/index.js";
import { CodexHarness } from "./codex/index.js";
import { disposeSharedCodexConnection } from "./codex/rpc.js";

export * from "./types.js";
export * from "./guard.js";
export { ClaudeHarness, CLAUDE_CAPABILITIES, parseClaudeLimitHit } from "./claude/index.js";
export { CodexHarness, CODEX_CAPABILITIES } from "./codex/index.js";

export interface HarnessRegistryOpts {
  /** Injectable harnesses (tests, and the E2E fake SDK). */
  harnesses?: Partial<Record<HarnessKind, Harness>>;
}

export class HarnessRegistry {
  private readonly map = new Map<HarnessKind, Harness>();

  constructor(opts: HarnessRegistryOpts = {}) {
    this.map.set("claude", opts.harnesses?.claude ?? new ClaudeHarness());
    this.map.set("codex", opts.harnesses?.codex ?? new CodexHarness());
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
    disposeSharedCodexConnection();
  }
}
