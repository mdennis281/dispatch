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
// Value import (not `import type`): the InspectService needs to CONSTRUCT a
// second Store over the installed instance's roots for `instance: "stable"`.
import { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import { createChat, ensureSession } from "../routes/dispatch.js";
import { SessionBroker } from "./session-broker.js";
import { TerminalService } from "./terminal.js";
import { MemoryService } from "./memory.js";
import { MemoryCommitter } from "./memory-committer.js";
import { MemoryHistoryService } from "./memory-history.js";
import { ProjectConfigService } from "./project-config.js";
import { ProjectConfigArchive } from "./project-config-archive.js";
import { InspectService, installedRoots } from "./inspect.js";
import { makeFakeQuery } from "./fake-sdk.js";
import { TitleService, makeFakeTitleGenerator } from "./title.js";
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
import { ReleaseService } from "./release.js";
import { ResumeScheduler } from "./resume-scheduler.js";
import { TrunkSyncService } from "./trunk-sync.js";
import { PrReviewWatcher } from "./pr-review-watcher.js";
import { FileIndexService } from "./file-index.js";
import { HarnessRegistry } from "../harness/index.js";
import { ManagerMcpBridge } from "./mcp/manager-http.js";

/** The shared base every service hangs off. */
export interface ServiceBase {
  config: ServerConfig;
  store: Store;
  bus: EventBus;
}

/** Injectable service overrides (tests supply fakes; prod omits them). */
export interface ServiceOverrides {
  harnesses?: HarnessRegistry;
  managerMcp?: ManagerMcpBridge;
  broker?: SessionBroker;
  terminals?: TerminalService;
  memory?: MemoryService;
  memoryCommitter?: MemoryCommitter;
  memoryHistory?: MemoryHistoryService;
  projectConfig?: ProjectConfigService;
  projectConfigArchive?: ProjectConfigArchive;
  inspect?: InspectService;
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
  release?: ReleaseService;
  resume?: ResumeScheduler;
  fileIndex?: FileIndexService;
  trunkSync?: TrunkSyncService;
  prReviewWatcher?: PrReviewWatcher;
}

/** Everything the routes/WS layer needs, wired to one bus + store. */
export interface Services extends ServiceBase {
  /** Installed agent runtimes and their capability/model catalogues. */
  harnesses: HarnessRegistry;
  /** HTTP front door used by runtimes that cannot consume in-process MCP. */
  managerMcp: ManagerMcpBridge;
  broker: SessionBroker;
  terminals: TerminalService;
  memory: MemoryService;
  /** Lands memory writes as commits on the primary checkout (profile-driven). */
  memoryCommitter: MemoryCommitter;
  /** Reads those commits back — when each fact was written, and what was retired. */
  memoryHistory: MemoryHistoryService;
  projectConfig: ProjectConfigService;
  projectConfigArchive: ProjectConfigArchive;
  /** Read-only cross-chat/project reads behind the session MCP's inspect tools. */
  inspect: InspectService;
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
  /** Knows whether a newer Dispatch release exists, and can launch the installer. */
  release: ReleaseService;
  /** Schedules a chat to continue itself once a usage limit lifts. */
  resume: ResumeScheduler;
  fileIndex: FileIndexService;
  /** Fast-forwards a project's primary checkout after its PRs land. */
  trunkSync: TrunkSyncService;
  /** Raises `review` attention (and wakes the owning chat) on PR activity. */
  prReviewWatcher: PrReviewWatcher;
  /** Start background wiring (attention, notifier, reconcile, auto-checkpoint). */
  start(): Promise<void>;
  /** Tear everything down (broker sessions, runners, subscriptions). */
  dispose(): Promise<void>;
}

/**
 * A hard process exit cannot run broker.dispose(), so any persisted live state
 * on the next boot represents an interrupted agent. Preserve completed/idle
 * colors, but turn orphaned running/waiting/queued records red.
 */
export async function recoverInterruptedChatStatuses(store: Store): Promise<void> {
  const chats = (await store.listChats()) ?? [];
  await Promise.all(
    chats
      .filter(
        (chat) =>
          chat.status === "running" ||
          chat.status === "waiting" ||
          chat.status === "queued" ||
          chat.status === "awaiting-input",
      )
      .map((chat) => store.patchChat(chat.id, { status: "error" })),
  );
}

export function createServices(
  base: ServiceBase,
  overrides: ServiceOverrides = {},
): Services {
  const { config, store, bus } = base;
  const harnesses = overrides.harnesses ?? new HarnessRegistry();
  const managerMcp =
    overrides.managerMcp ?? new ManagerMcpBridge(`http://127.0.0.1:${config.port}`);

  // `DISPATCH_FAKE_SDK=1` swaps the real Agent-SDK `query()` for a deterministic
  // in-process echo (E2E only) — no `claude` subprocess, no auth/network. Prod
  // and unit tests (which inject their own broker) are untouched.
  const brokerDeps =
    process.env.DISPATCH_FAKE_SDK === "1" ? { query: makeFakeQuery() } : undefined;
  /** Retention sweep handle, armed in `start()` and cleared in `dispose()`. */
  let terminalSweep: ReturnType<typeof setInterval> | undefined;
  // How often the terminal retention sweep runs. Hourly: the window it enforces
  // is measured in days, so anything tighter is just disk churn.
  const TERMINAL_SWEEP_MS = 60 * 60_000;
  // Persistent named shells exposed to sessions as `mcp__manager__terminal`.
  // The store makes them durable: the roster and each shell's transcript survive
  // a restart, so "what did that build print?" outlives the process that ran it.
  const terminals = overrides.terminals ?? new TerminalService({ bus, store });
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
  // Reads those commits back: when a fact was written, how often it's been
  // rewritten, and which facts were deliberately RETIRED — the context a
  // consolidation pass needs before it decides what to delete.
  const memoryHistory =
    overrides.memoryHistory ?? new MemoryHistoryService({ store, projectConfig });
  // Export/import a project's `.dispatch/` as a portable `.dispatch` zip, and
  // scaffold a fresh one from the `.data` record. Reads the config dir, (re)watches
  // + reloads through `projectConfig` so an import/scaffold takes effect live.
  const projectConfigArchive =
    overrides.projectConfigArchive ??
    new ProjectConfigArchive({ store, projectConfig });
  // Read-only sweep across every chat + project, exposed to sessions as
  // `chat_find`/`chat_read`/`project_info`. Given `makeStore` so a DEV server can
  // open the INSTALLED instance's store and answer questions about production
  // chats — the one thing this whole surface exists to make cheap.
  const inspect =
    overrides.inspect ??
    new InspectService({
      store,
      projectConfig,
      memory,
      stableRoots: () => installedRoots(),
      makeStore: (dataDir, configDir) => new Store(dataDir, configDir),
    });
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
  // …and, via `terminals`, attributes a listener on ANY port to the chat whose
  // shell started it — the only way an agent's own dev server on a port nobody
  // declared is visible at all.
  const processes =
    overrides.processes ?? new ProcessService({ store, terminals });
  const broker =
    overrides.broker ??
    new SessionBroker({
      store,
      bus,
      maxActiveSessions: config.maxActiveSessions,
      terminals,
      memory,
      memoryHistory,
      github,
      runner,
      worktrees,
      // Self-contained `.dispatch/` config: authored agents/modes/
      // instructions (source of truth) resolved config-first, `.data` fallback.
      projectConfig,
      harnesses,
      managerMcp,
      inspect,
      deps: brokerDeps,
    });
  const title =
    overrides.title ??
    new TitleService({
      store,
      bus,
      harnesses,
      generateText:
        process.env.DISPATCH_FAKE_SDK === "1" ? makeFakeTitleGenerator() : undefined,
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
  // "Is there a newer Dispatch than this one." Inert on a payload built from
  // source: with no release-manifest.json there is nothing to compare against.
  // The channel subscription is read/written through the settings store because
  // it lives in `config/`, the one directory an update never replaces.
  const release =
    overrides.release ??
    new ReleaseService({
      bus,
      channelStore: {
        read: async () => (await store.getSettings()).updateChannel ?? "stable",
        write: async (updateChannel) => {
          // Read-modify-write against the CURRENT settings, not a captured copy:
          // this runs whenever the user flips the switch, long after boot.
          const current = await store.getSettings();
          await store.saveSettings({ ...current, updateChannel });
        },
      },
    });
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
  // Review activity → the Attention Queue, and a nudge for the chat that OWNS the
  // PR. `watch_pr` only notices while an agent keeps calling it; the run that
  // motivated this stopped calling after one "no CI checks configured" reply and
  // then missed two rounds of review comments entirely. This is the half that
  // doesn't depend on anybody remembering to ask.
  const prReviewWatcher =
    overrides.prReviewWatcher ??
    new PrReviewWatcher({
      store,
      bus,
      github: {
        prMergeState: (n, o) => github.prMergeState(n, o),
        prChecks: (repo, n) => github.prChecks(repo, n),
        reviewThreads: (repo, n) => github.reviewThreads(repo, n),
        prReviewState: (repo, n) => github.prReviewState(repo, n),
      },
      // Same lazy-session path the ResumeScheduler uses — by the time a review
      // round lands, the chat's subprocess is long gone.
      resume: async (chatId, text) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text);
      },
      // A chat that's mid-turn is already working (quite possibly inside
      // `watch_pr`); it gets the badge and nothing more.
      isBusy: (chatId) => {
        const status = broker.getStatus(chatId);
        return (
          status === "running" || status === "waiting" || status === "awaiting-input"
        );
      },
    });
  // `create_pr` pre-seeds the watcher so the first sweep after a PR opens can't
  // badge the chat for activity that predates it.
  // Fire-and-forget: arming now reads GitHub, and `create_pr` must not wait on
  // (or fail from) a dedup optimisation. A rejection here is already swallowed
  // inside `arm`; the `.catch` is belt-and-braces against an unhandled rejection.
  broker.armPrWatch = (chatId, ref) => {
    void prReviewWatcher.arm(chatId, ref).catch(() => {});
  };
  // `mcp__manager__spawn_chat`: an agent starting ANOTHER chat, after the human
  // approved it (the broker asks; this only runs once they said yes). Deliberately
  // the SAME `createChat` → `ensureSession` → `sendMessage` path a human's "New
  // chat" takes, so a spawned chat is an ordinary chat in every respect — same
  // project defaults, worktree isolation, workflow profile and guards. The purpose
  // tag is the only difference, and it exists so the sidebar can say where the
  // chat came from.
  broker.spawnChat = async ({ request, project, parentChatId }) => {
    const chat = await createChat(services, {
      projectId: project.id,
      title: request.title,
      modeId: request.modeId,
      agentId: request.agentId,
      effort: request.effort,
      model: request.model,
      purpose: { kind: "spawned", label: `Spawned by chat ${parentChatId}` },
    });
    await ensureSession(services, chat.id);
    await broker.sendMessage(chat.id, request.prompt);
    return {
      chatId: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName: project.name,
    };
  };

  let offCheckpoint: (() => void) | undefined;
  let offTitle: (() => void) | undefined;
  let offMemoryMigrate: (() => void) | undefined;

  const services: Services = {
    config,
    store,
    bus,
    harnesses,
    managerMcp,
    broker,
    terminals,
    memory,
    memoryCommitter,
    memoryHistory,
    projectConfig,
    projectConfigArchive,
    inspect,
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
    release,
    resume,
    fileIndex,
    trunkSync,
    prReviewWatcher,

    async start(): Promise<void> {
      // This runs before clients hydrate. Graceful shutdowns have already
      // persisted `done`; only a killed/crashed process leaves a live status.
      await recoverInterruptedChatStatuses(store).catch((err) => {
        console.error("[Dispatch] chat status recovery failed (continuing):", err);
      });

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
      // Release polling. A no-op unless this payload came from a release, and
      // its first check is deferred so an unreachable GitHub delays no boot.
      // Hydrate the channel FIRST — a check that ran before the subscription
      // loaded would ask the stable endpoint on behalf of an unstable install.
      await release.hydrate().catch(() => {});
      safeStart("release", () => release.start());
      // Notices review rounds on PRs chats own — the half of the loop that
      // doesn't require an agent to keep asking.
      safeStart("prReviewWatcher", () => prReviewWatcher.start());

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

      // Adopt the persisted terminal roster (as archived — this process owns no
      // shells yet) and start the retention sweep. `unref` so a timer can never
      // be the reason the process won't exit.
      try {
        await terminals.reconcile();
        await terminals.sweep();
      } catch {
        /* an unreadable terminals.json must never block boot either */
      }
      terminalSweep = setInterval(() => {
        void terminals.sweep().catch(() => {});
      }, TERMINAL_SWEEP_MS);
      terminalSweep.unref?.();
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
      // Unsubscribe first, then let an in-flight sweep land rather than yanking
      // the store out from under it.
      prReviewWatcher.dispose();
      await prReviewWatcher.drain().catch(() => {});
      usage.stop();
      release.stop();
      // Disarm first so nothing new fires, then let an in-flight resume land
      // before the broker goes away under it.
      resume.dispose();
      await resume.drain().catch(() => {});
      await runner.stopAll().catch(() => {});
      await broker.dispose().catch(() => {});
      await harnesses.dispose().catch(() => {});
      if (terminalSweep) clearInterval(terminalSweep);
      terminalSweep = undefined;
      // Kill any lingering persistent shells after the broker unwinds. Flush
      // their queued output FIRST — the tail of a transcript is usually the part
      // that explains why anyone is reading it.
      await terminals.flush().catch(() => {});
      terminals.dispose();
    },
  };

  return services;
}
