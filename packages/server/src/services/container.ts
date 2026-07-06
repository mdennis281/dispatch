/**
 * Service container — the single wiring seam the routes/WS layer builds on.
 *
 * `createServices()` constructs (or accepts injected fakes for) every backend
 * service off one shared {config, store, bus} context, plus the cross-cutting
 * background wiring:
 *   - AttentionQueue aggregates the global needs-input inbox off the bus.
 *   - Notifier fires optional outbound webhooks on attention events.
 *   - RunnerService.reconcile() marks dead subApp runners stopped at boot.
 *   - an auto-checkpoint subscriber snapshots a chat's worktree after each
 *     assistant message (best-effort) so `rollback` has a code point to restore.
 *
 * Tests pass fully-formed fakes via `overrides`; production gets the real
 * execa/SDK-backed services. `start()`/`dispose()` bound the background work.
 */
import type { ServerConfig } from "../config.js";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import { SessionBroker } from "./session-broker.js";
import { TerminalService } from "./terminal.js";
import { MemoryService } from "./memory.js";
import { ProjectConfigService } from "./project-config.js";
import { makeFakeQuery } from "./fake-sdk.js";
import { TitleService, makeFakeTitleQuery } from "./title.js";
import { CheckpointService } from "./checkpoint.js";
import { WorktreeService } from "./worktree.js";
import { WorktreeDetector } from "./worktree-detector.js";
import { RunnerService } from "./runner.js";
import { GitHubService } from "./github.js";
import { Notifier } from "./notifier.js";
import { AttentionQueue } from "./attention.js";

/** The shared base every service hangs off. */
export interface ServiceBase {
  config: ServerConfig;
  store: Store;
  bus: EventBus;
}

/** Injectable service overrides (tests supply fakes; prod omits them). */
export interface ServiceOverrides {
  broker?: SessionBroker;
  terminals?: TerminalService;
  memory?: MemoryService;
  projectConfig?: ProjectConfigService;
  title?: TitleService;
  checkpoints?: CheckpointService;
  worktrees?: WorktreeService;
  worktreeDetector?: WorktreeDetector;
  runner?: RunnerService;
  github?: GitHubService;
  notifier?: Notifier;
  attention?: AttentionQueue;
}

/** Everything the routes/WS layer needs, wired to one bus + store. */
export interface Services extends ServiceBase {
  broker: SessionBroker;
  terminals: TerminalService;
  memory: MemoryService;
  projectConfig: ProjectConfigService;
  title: TitleService;
  checkpoints: CheckpointService;
  worktrees: WorktreeService;
  worktreeDetector: WorktreeDetector;
  runner: RunnerService;
  github: GitHubService;
  notifier: Notifier;
  attention: AttentionQueue;
  /** Start background wiring (attention, notifier, reconcile, auto-checkpoint). */
  start(): Promise<void>;
  /** Tear everything down (broker sessions, runners, subscriptions). */
  dispose(): Promise<void>;
}

export function createServices(
  base: ServiceBase,
  overrides: ServiceOverrides = {},
): Services {
  const { config, store, bus } = base;

  // `CM_FAKE_SDK=1` swaps the real Agent-SDK `query()` for a deterministic
  // in-process echo (E2E only) — no `claude` subprocess, no auth/network. Prod
  // and unit tests (which inject their own broker) are untouched.
  const brokerDeps =
    process.env.CM_FAKE_SDK === "1" ? { query: makeFakeQuery() } : undefined;
  // Persistent named shells exposed to sessions as `mcp__manager__terminal`.
  const terminals = overrides.terminals ?? new TerminalService({ bus });
  // Self-contained `.claude-manager/` project config: discovers + validates the
  // authored config in a managed repo, syncs it into the project store (authored
  // overrides `.data`), and watches it for live reload. Projects without a
  // `.claude-manager/` fall back to the `.data` store untouched (back-compat).
  // Constructed before `memory` so it can relocate a config-dir project's memory
  // to the repo's committable `.claude-manager/memory/` source of truth.
  const projectConfig =
    overrides.projectConfig ?? new ProjectConfigService({ store, bus });
  // Per-project durable agent memory: injected at session start + exposed to the
  // agent as `mcp__manager__remember|recall|forget`, and curated in the UI. Reads
  // from the repo `.claude-manager/memory/` when the project has a config dir
  // (source of truth), else the `.data` store (back-compat).
  const memory =
    overrides.memory ?? new MemoryService({ store, bus, projectConfig });
  // GitHub control plane (PRs + Actions). Constructed before the broker so it can
  // back the session MCP's `wait_for_pr` PR merge-state poll.
  const github = overrides.github ?? new GitHubService({ bus, store });
  const broker =
    overrides.broker ??
    new SessionBroker({
      store,
      bus,
      maxActiveSessions: config.maxActiveSessions,
      terminals,
      memory,
      github,
      // Self-contained `.claude-manager/` config: authored agents/modes/
      // instructions (source of truth) resolved config-first, `.data` fallback.
      projectConfig,
      deps: brokerDeps,
    });
  const title =
    overrides.title ??
    new TitleService({
      store,
      bus,
      query:
        process.env.CM_FAKE_SDK === "1" ? makeFakeTitleQuery() : undefined,
    });
  const checkpoints =
    overrides.checkpoints ?? new CheckpointService({ store, bus });
  const worktrees = overrides.worktrees ?? new WorktreeService({ bus, store });
  // Detects worktrees the AGENT creates during a turn (`pnpm worktree` / `git
  // worktree add` via Bash) and attaches them to the owning chat — the manager
  // never creates them for the agent, so it has to discover them post-turn.
  const worktreeDetector =
    overrides.worktreeDetector ??
    new WorktreeDetector({ store, bus, worktrees });
  // Keep the detector's baseline in step with MANAGER-side removals: `remove()`
  // detaches the chat record outside the detector, so evict the path from `known`
  // or a worktree recreated at the same path would never be re-attributed.
  worktrees.onWorktreeRemoved = (path) => worktreeDetector.forget(path);
  const runner = overrides.runner ?? new RunnerService({ store, bus });
  const notifier = overrides.notifier ?? new Notifier({ bus, store });
  const attention = overrides.attention ?? new AttentionQueue({ bus });

  let offCheckpoint: (() => void) | undefined;
  let offTitle: (() => void) | undefined;
  let offMemoryMigrate: (() => void) | undefined;

  const services: Services = {
    config,
    store,
    bus,
    broker,
    terminals,
    memory,
    projectConfig,
    title,
    checkpoints,
    worktrees,
    worktreeDetector,
    runner,
    github,
    notifier,
    attention,

    async start(): Promise<void> {
      // One-time transparent memory migration: when a project has (or gains) a
      // `.claude-manager/` config, copy any legacy `.data` memories into the
      // repo `memory/` source of truth. Subscribed BEFORE `projectConfig.start()`
      // so the per-project load events it fires drive migration on boot too.
      // Idempotent + best-effort.
      offMemoryMigrate = bus.on("project-config-update", (evt) => {
        if (evt.config) void memory.migrateProject(evt.projectId).catch(() => {});
      });

      // Discover + sync every project's `.claude-manager/` config FIRST so the
      // store reflects authored overrides before the detector/broker read it.
      // Best-effort — a bad config surfaces as a structured error, never a block.
      await projectConfig.start().catch(() => {});

      attention.start();
      notifier.start();

      // Agent-created worktree detection: subscribe to turn-complete signals and
      // seed the per-project baseline. Best-effort — a git/seed failure here must
      // never block boot.
      await worktreeDetector.start().catch(() => {});

      // AI title: when a turn completes (a `result` transcript row), generate a
      // title from the first user message IFF the chat is still on its default
      // "New chat" title. The service self-gates on the default title, so this
      // fires effectively once (the first turn) and no-ops thereafter. Purely
      // best-effort — a failed/absent title just leaves the default.
      offTitle = bus.on("chat-message", (evt) => {
        if (evt.message.kind !== "result") return;
        void title.maybeGenerateInitialTitle(evt.chatId);
      });

      // Auto-checkpoint: after each assistant message, snapshot the owning
      // chat's worktree (if any) keyed to that message id, anchoring the SDK
      // fork target to the message uuid. Purely best-effort — no worktree or a
      // git failure just means no rollback point for that message.
      offCheckpoint = bus.on("chat-message", (evt) => {
        const msg = evt.message;
        if (msg.kind !== "assistant" || !msg.uuid) return;
        void (async () => {
          try {
            const chat = await store.getChat(evt.chatId);
            const worktreePath = chat?.worktrees[0];
            if (!worktreePath) return;
            await checkpoints.snapshot({
              chatId: evt.chatId,
              messageId: msg.id,
              worktreePath,
              sessionMessageUuid: msg.uuid,
            });
          } catch {
            /* best-effort: rollback simply won't have a point here */
          }
        })();
      });

      // Boot reconciliation of persisted runners (best-effort).
      try {
        await runner.reconcile();
      } catch {
        /* a missing runners.json / dead pid probe must never block boot */
      }
    },

    async dispose(): Promise<void> {
      offCheckpoint?.();
      offCheckpoint = undefined;
      offTitle?.();
      offTitle = undefined;
      offMemoryMigrate?.();
      offMemoryMigrate = undefined;
      // Unsubscribe FIRST (so broker teardown's `done` events don't enqueue new
      // detection), then drain any in-flight pass so no `git` subprocess outlives
      // the dataDir/worktree it was spawned against.
      worktreeDetector.stop();
      await worktreeDetector.drain().catch(() => {});
      projectConfig.stop();
      notifier.stop();
      attention.stop();
      await runner.stopAll().catch(() => {});
      await broker.dispose().catch(() => {});
      // Kill any lingering persistent shells after the broker unwinds.
      terminals.dispose();
    },
  };

  return services;
}
