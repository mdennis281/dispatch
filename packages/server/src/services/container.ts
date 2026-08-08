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
import { ensureSession } from "../routes/dispatch.js";
import { SessionBroker } from "./session-broker.js";
import { TerminalService } from "./terminal.js";
import { MemoryService } from "./memory.js";
import { MemoryCommitter } from "./memory-committer.js";
import { ProjectConfigService } from "./project-config.js";
import { ProjectConfigArchive } from "./project-config-archive.js";
import { makeFakeQuery } from "./fake-sdk.js";
import { TitleService, makeFakeTitleQuery } from "./title.js";
import { CheckpointService } from "./checkpoint.js";
import { WorktreeService } from "./worktree.js";
import { WorktreeDetector } from "./worktree-detector.js";
import { GitService } from "./git.js";
import { CommitMessageService } from "./commit-message.js";
import { RunnerService } from "./runner.js";
import { ProcessService } from "./processes.js";
import { GitHubService } from "./github.js";
import { Notifier } from "./notifier.js";
import { AttentionQueue } from "./attention.js";
import { UsageService } from "./usage.js";
import { ResumeScheduler } from "./resume-scheduler.js";
import { TrunkSyncService } from "./trunk-sync.js";
import { FileIndexService } from "./file-index.js";

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
  memoryCommitter?: MemoryCommitter;
  projectConfig?: ProjectConfigService;
  projectConfigArchive?: ProjectConfigArchive;
  title?: TitleService;
  checkpoints?: CheckpointService;
  worktrees?: WorktreeService;
  worktreeDetector?: WorktreeDetector;
  git?: GitService;
  commitMessage?: CommitMessageService;
  runner?: RunnerService;
  processes?: ProcessService;
  github?: GitHubService;
  notifier?: Notifier;
  attention?: AttentionQueue;
  usage?: UsageService;
  resume?: ResumeScheduler;
  fileIndex?: FileIndexService;
  trunkSync?: TrunkSyncService;
}

/** Everything the routes/WS layer needs, wired to one bus + store. */
export interface Services extends ServiceBase {
  broker: SessionBroker;
  terminals: TerminalService;
  memory: MemoryService;
  /** Lands memory writes as commits on the primary checkout (profile-driven). */
  memoryCommitter: MemoryCommitter;
  projectConfig: ProjectConfigService;
  projectConfigArchive: ProjectConfigArchive;
  title: TitleService;
  checkpoints: CheckpointService;
  worktrees: WorktreeService;
  worktreeDetector: WorktreeDetector;
  /** Working-copy git (status/stage/commit/branch/stash) for the Source Control UI. */
  git: GitService;
  /** One-shot AI commit messages drafted from the staged diff. */
  commitMessage: CommitMessageService;
  runner: RunnerService;
  processes: ProcessService;
  github: GitHubService;
  notifier: Notifier;
  attention: AttentionQueue;
  usage: UsageService;
  /** Schedules a chat to continue itself once a usage limit lifts. */
  resume: ResumeScheduler;
  fileIndex: FileIndexService;
  /** Fast-forwards a project's primary checkout after its PRs land. */
  trunkSync: TrunkSyncService;
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

  // `DISPATCH_FAKE_SDK=1` swaps the real Agent-SDK `query()` for a deterministic
  // in-process echo (E2E only) — no `claude` subprocess, no auth/network. Prod
  // and unit tests (which inject their own broker) are untouched.
  const brokerDeps =
    process.env.DISPATCH_FAKE_SDK === "1" ? { query: makeFakeQuery() } : undefined;
  // Persistent named shells exposed to sessions as `mcp__manager__terminal`.
  const terminals = overrides.terminals ?? new TerminalService({ bus });
  // Self-contained `.dispatch/` project config: discovers + validates the
  // authored config in a managed repo, syncs it into the project store (authored
  // overrides `.data`), and watches it for live reload. Projects without a
  // `.dispatch/` fall back to the `.data` store untouched (back-compat).
  // Constructed before `memory` so it can relocate a config-dir project's memory
  // to the repo's committable `.dispatch/memory/` source of truth.
  const projectConfig =
    overrides.projectConfig ?? new ProjectConfigService({ store, bus });
  // Per-project durable agent memory: injected at session start + exposed to the
  // agent as `mcp__manager__remember|recall|forget`, and curated in the UI. Reads
  // from the repo `.dispatch/memory/` when the project has a config dir
  // (source of truth), else the `.data` store (back-compat).
  const memory =
    overrides.memory ?? new MemoryService({ store, bus, projectConfig });
  // `trunkSync` is constructed further down (it needs the broker's chat wiring),
  // but the memory committer needs to reach it. A tiny forwarder keeps the
  // construction order readable instead of shuffling half the container around.
  const lazyTrunkSync = {
    syncForProject: (projectId: string, trigger: "merge") =>
      trunkSync.syncForProject(projectId, trigger),
  };
  // Memory always writes to the PRIMARY checkout (it's project-scoped, not
  // branch-scoped), so without this every `remember` would sit there as a
  // permanently-uncommitted change no worktree can see and no PR can carry.
  // Debounces a burst of writes into one pathspec-limited `chore(memory)` commit
  // — but only for projects whose workflow profile asks for it.
  // Constructed after `trunkSync` (below) is declared — see the `let` there.
  const memoryCommitter =
    overrides.memoryCommitter ??
    new MemoryCommitter({ store, bus, projectConfig, trunkSync: lazyTrunkSync });
  // Export/import a project's `.dispatch/` as a portable `.dispatch` zip, and
  // scaffold a fresh one from the `.data` record. Reads the config dir, (re)watches
  // + reloads through `projectConfig` so an import/scaffold takes effect live.
  const projectConfigArchive =
    overrides.projectConfigArchive ??
    new ProjectConfigArchive({ store, projectConfig });
  // GitHub control plane (PRs + Actions). Constructed before the broker so it can
  // back the session MCP's `watch_pr` checks / review-thread / merge-state polls.
  const github = overrides.github ?? new GitHubService({ bus, store });
  // Worktrees + subApp runner are constructed BEFORE the broker so the session
  // MCP's `run_subapp` tool can launch apps (and resolve/create worktrees).
  const worktrees = overrides.worktrees ?? new WorktreeService({ bus, store });
  // Working-copy git for the Source Control view. Stateless (every call is
  // scoped to a `repoPath` the route passes), so it needs no bus/store wiring.
  const git = overrides.git ?? new GitService();
  const commitMessage =
    overrides.commitMessage ?? new CommitMessageService({ git });
  const runner = overrides.runner ?? new RunnerService({ store, bus });
  // OS-level port/pid inspector + bulk kill: reaps orphaned dev-server
  // grandchildren the runner records lost track of (server restart, half-killed
  // tree) and surfaces what's actually squatting a project's ports.
  const processes = overrides.processes ?? new ProcessService({ store });
  const broker =
    overrides.broker ??
    new SessionBroker({
      store,
      bus,
      maxActiveSessions: config.maxActiveSessions,
      terminals,
      memory,
      github,
      runner,
      worktrees,
      // Self-contained `.dispatch/` config: authored agents/modes/
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
        process.env.DISPATCH_FAKE_SDK === "1" ? makeFakeTitleQuery() : undefined,
    });
  const checkpoints =
    overrides.checkpoints ?? new CheckpointService({ store, bus });
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
  const notifier = overrides.notifier ?? new Notifier({ bus, store });
  const attention = overrides.attention ?? new AttentionQueue({ bus });
  // Subscription usage (5h + weekly) for the header meter. Polls the account
  // OAuth usage endpoint once (server-side) and fans snapshots to every client.
  const usage = overrides.usage ?? new UsageService({ bus });
  // Backs the composer's file-path picker: the browser can't see the filesystem,
  // so real paths have to be listed server-side.
  const fileIndex = overrides.fileIndex ?? new FileIndexService();
  // Usage-limit auto-resume. Constructed AFTER the broker (it sends through it)
  // and hooked back in below, since a limit is only visible on the broker's
  // errored turn-end. `send` goes through the same lazy session path the routes
  // use — by the time a limit lifts the subprocess is long gone.
  const resume =
    overrides.resume ??
    new ResumeScheduler({
      store,
      bus,
      send: async (chatId, text) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text);
      },
    });
  broker.onTurnError = (chatId, reason) => {
    void resume.onTurnError(chatId, reason).catch(() => {});
  };
  // A merged PR means the trunk moved. Under the `review` profile the primary
  // checkout is never worked in, so nothing else would ever advance it — and the
  // next worktree cut from a stale base inherits the drift. Fires both for merges
  // we perform and for ones `watch_pr` observes the auto-merge job performing.
  const trunkSync =
    overrides.trunkSync ?? new TrunkSyncService({ store, bus, projectConfig });
  github.onMerged = ({ chatId }) => {
    void trunkSync.syncForChat(chatId, "merge").catch(() => {});
  };

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
    memoryCommitter,
    projectConfig,
    projectConfigArchive,
    title,
    checkpoints,
    worktrees,
    worktreeDetector,
    git,
    commitMessage,
    runner,
    processes,
    github,
    notifier,
    attention,
    usage,
    resume,
    fileIndex,
    trunkSync,

    async start(): Promise<void> {
      // One-time transparent memory migration: when a project has (or gains) a
      // `.dispatch/` config, copy any legacy `.data` memories into the
      // repo `memory/` source of truth. Subscribed BEFORE `projectConfig.start()`
      // so the per-project load events it fires drive migration on boot too.
      // Idempotent + best-effort.
      offMemoryMigrate = bus.on("project-config-update", (evt) => {
        if (evt.config) void memory.migrateProject(evt.projectId).catch(() => {});
      });

      // Discover + sync every project's `.dispatch/` config FIRST so the
      // store reflects authored overrides before the detector/broker read it.
      // Best-effort — a bad config surfaces as a structured error, never a block.
      await projectConfig.start().catch(() => {});

      // Best-effort background services. A throw in any ONE of these must not
      // abort boot and silently skip the wiring BELOW it — that ordering once
      // risked leaving AI titles + auto-checkpoints un-wired with no error at
      // all. Isolate + LOG each failure so it's visible, never a silent cascade.
      const safeStart = (label: string, fn: () => void) => {
        try {
          fn();
        } catch (err) {
          console.error(`[Dispatch] ${label}.start() failed (continuing):`, err);
        }
      };
      safeStart("attention", () => attention.start());
      safeStart("memoryCommitter", () => memoryCommitter.start());
      safeStart("notifier", () => notifier.start());
      // Subscription usage polling (a missing token / offline just yields an
      // "unavailable" snapshot the header meter hides on).
      safeStart("usage", () => usage.start());

      // Agent-created worktree detection: subscribe to turn-complete signals and
      // seed the per-project baseline. Best-effort — a git/seed failure here must
      // never block boot.
      await worktreeDetector.start().catch(() => {});

      // AI title: generate one from the first user message IFF the chat is still
      // on its default "New chat" title. We fire as soon as the user's prompt
      // lands (`user` row) so a new chat is named right after the first send
      // rather than only once the whole turn finishes; we also retry on `result`
      // to cover a first prompt that carried no text (image-only). The service
      // self-gates on the default title + dedupes in-flight runs, so this is
      // effectively once. Purely best-effort — a failure just leaves the default.
      offTitle = bus.on("chat-message", (evt) => {
        if (evt.message.kind !== "user" && evt.message.kind !== "result") return;
        // Caught, unlike every other `void` in this file, because it wasn't: a
        // rejection here had no handler, and an unhandled rejection is fatal to
        // the whole process. Titling is best-effort; it must never be terminal.
        void title.maybeGenerateInitialTitle(evt.chatId).catch(() => {});
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

      // Re-arm auto-resumes persisted before the last shutdown, so a restart
      // never strands a chat waiting on a limit that has since lifted.
      await resume.restore().catch(() => {});

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
      // Unsubscribe first, then let an in-flight memory commit finish so no
      // `git` subprocess outlives the repo it was spawned against.
      memoryCommitter.stop();
      await memoryCommitter.drain().catch(() => {});
      notifier.stop();
      attention.stop();
      usage.stop();
      // Disarm first so nothing new fires, then let an in-flight resume land
      // before the broker goes away under it.
      resume.dispose();
      await resume.drain().catch(() => {});
      await runner.stopAll().catch(() => {});
      await broker.dispose().catch(() => {});
      // Kill any lingering persistent shells after the broker unwinds.
      terminals.dispose();
    },
  };

  return services;
}
