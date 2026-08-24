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
import {
  PrSnapshotSchema,
  prRecordKey,
  resolveWorkflow,
  spawnedPurposeLabel,
  type PRRef,
  type PrRecord,
  type PrSnapshot,
} from "@dispatch/shared";
import { launchAgentTask } from "./agent-tasks.js";
import { resolveReviewer } from "./reviewer.js";
import type { EventBus } from "../bus.js";
import { createChat, ensureSession } from "../routes/dispatch.js";
import { ChatMessenger } from "./chat-messenger.js";
import { SessionBroker } from "./session-broker.js";
import { TerminalService } from "./terminal.js";
import { MemoryService } from "./memory.js";
import { AuthoredConfigService } from "./authored-config.js";
import { SlashCommandService } from "./slash-commands.js";
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
import { WorktreeReaper } from "./worktree-reaper.js";
import { GitService } from "./git.js";
import { CommitMessageService } from "./commit-message.js";
import { RunnerService } from "./runner.js";
import { ProcessService, defaultProcTable } from "./processes.js";
import { ChatProcessService } from "./chat-processes.js";
import { ProcTableCache } from "./proc-table-cache.js";
import { ResourceService } from "./resources.js";
import { GitHubService } from "./github.js";
import { Notifier } from "./notifier.js";
import { PushService } from "./push.js";
import { AttentionQueue } from "./attention.js";
import { UsageService } from "./usage.js";
import { ReleaseService } from "./release.js";
import { ResumeScheduler } from "./resume-scheduler.js";
import { TrunkSyncService } from "./trunk-sync.js";
import { PrReviewWatcher } from "./pr-review-watcher.js";
import { PrRegistry } from "./pr-registry.js";
import { FileIndexService } from "./file-index.js";
import { MetricsService } from "./metrics.js";
import { MetricsBackfill } from "./metrics-backfill.js";
import { FsExplorerService } from "./fs-explorer.js";
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
  authored?: AuthoredConfigService;
  slashCommands?: SlashCommandService;
  memoryCommitter?: MemoryCommitter;
  memoryHistory?: MemoryHistoryService;
  projectConfig?: ProjectConfigService;
  projectConfigArchive?: ProjectConfigArchive;
  inspect?: InspectService;
  title?: TitleService;
  checkpoints?: CheckpointService;
  worktrees?: WorktreeService;
  worktreeDetector?: WorktreeDetector;
  worktreeReaper?: WorktreeReaper;
  git?: GitService;
  commitMessage?: CommitMessageService;
  runner?: RunnerService;
  processes?: ProcessService;
  chatProcesses?: ChatProcessService;
  procTableCache?: ProcTableCache;
  resources?: ResourceService;
  github?: GitHubService;
  notifier?: Notifier;
  push?: PushService;
  attention?: AttentionQueue;
  usage?: UsageService;
  release?: ReleaseService;
  resume?: ResumeScheduler;
  fileIndex?: FileIndexService;
  metrics?: MetricsService;
  metricsBackfill?: MetricsBackfill;
  fsExplorer?: FsExplorerService;
  trunkSync?: TrunkSyncService;
  prReviewWatcher?: PrReviewWatcher;
  prRegistry?: PrRegistry;
  chatMessenger?: ChatMessenger;
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
  /** App-level (shipped + user-global) instructions and skills. */
  authored: AuthoredConfigService;
  /** What the composer's `/` menu offers for a chat. */
  slashCommands: SlashCommandService;
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
  /** Removes worktrees whose branch has landed, so nobody has to remember to. */
  worktreeReaper: WorktreeReaper;
  /** Working-copy git (status/stage/commit/branch/stash) for the Source Control UI. */
  git: GitService;
  /** One-shot AI commit messages drafted from the staged diff. */
  commitMessage: CommitMessageService;
  runner: RunnerService;
  processes: ProcessService;
  /** Per-chat process totals for the sidebar, and the manual reap behind them. */
  chatProcesses: ChatProcessService;
  procTableCache: ProcTableCache;
  resources: ResourceService;
  github: GitHubService;
  notifier: Notifier;
  /** Server-sent Web Push — the only delivery path an iOS home-screen app has. */
  push: PushService;
  attention: AttentionQueue;
  usage: UsageService;
  /** Knows whether a newer Dispatch release exists, and can launch the installer. */
  release: ReleaseService;
  /** Schedules a chat to continue itself once a usage limit lifts. */
  resume: ResumeScheduler;
  /** Chat-to-chat messaging behind `chat_send`/`chat_ask`/`chat_reply`/`chat_state`. */
  chatMessenger: ChatMessenger;
  fileIndex: FileIndexService;
  /** The SQLite usage ledger behind the Metrics view. */
  metrics: MetricsService;
  /** The one-time transcript import that gives that view history on day one. */
  metricsBackfill: MetricsBackfill;
  /** Directory listings, stats, drives/mounts and writes for the file explorer. */
  fsExplorer: FsExplorerService;
  /** Fast-forwards a project's primary checkout after its PRs land. */
  trunkSync: TrunkSyncService;
  /** Raises `review` attention (and wakes the owning chat) on PR activity. */
  prReviewWatcher: PrReviewWatcher;
  /** The tracked-PR catalog — the Workspace view's third registry. */
  prRegistry: PrRegistry;
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
  // How often the unattended worktree sweep runs. Hourly for the same reason,
  // plus one this timer alone doesn't carry: the chat-idle trigger already
  // removes a landed tree seconds after its owner stops, so by the time this
  // fires there is usually nothing left for it to find. It exists for the trees
  // whose chat never came back.
  const WORKTREE_SWEEP_MS = 60 * 60_000;
  // Persistent named shells exposed to sessions as `mcp__dispatch-workspace__terminal`.
  // The store makes them durable: the roster and each shell's transcript survive
  // a restart, so "what did that build print?" outlives the process that ran it.
  const terminals = overrides.terminals ?? new TerminalService({ bus, store });
  // Self-contained `.dispatch/` project config: discovers + validates the
  // authored config in a managed repo, syncs it into the project store (authored
  // overrides `.data`), and watches it for live reload. Projects without a
  // `.dispatch/` fall back to the `.data` store untouched (back-compat).
  // Constructed before `memory` so it can relocate a config-dir project's memory
  // to the repo's committable `.dispatch/memory/` source of truth.
  // The usage ledger. Constructed before the broker because the broker RECORDS
  // into it; per-instance (it lives in `.data`, never the shared `config/`) for
  // the same reason `runners.json` is — two processes writing one SQLite file
  // over a shared/network path is a corruption story nobody needs.
  const metrics = overrides.metrics ?? new MetricsService({ db: store.stateDb });
  const metricsBackfill =
    overrides.metricsBackfill ?? new MetricsBackfill({ store, metrics });
  const projectConfig =
    overrides.projectConfig ?? new ProjectConfigService({ store, bus });
  // Per-project durable agent memory: injected at session start + exposed to the
  // agent as `mcp__dispatch-memory__remember|recall|forget`, and curated in the UI. Reads
  // from the repo `.dispatch/memory/` when the project has a config dir
  // (source of truth), else the `.data` store (back-compat).
  const memory =
    overrides.memory ?? new MemoryService({ store, bus, projectConfig });
  // App-level authored guidance: Dispatch's own shipped instructions + skills,
  // and the operator's machine-wide ones under `<config>/global/`. Also the
  // write surface behind `mcp__dispatch-config__config_write`. Both scopes are
  // read on every session launch, so it is constructed once and shared.
  const authored =
    overrides.authored ?? new AuthoredConfigService({ globalRoot: store.globalConfigDir() });
  // The `/` command menu. Holds the process-wide snapshot of the runtime's
  // built-in commands, so it must be a singleton — see `slash-commands.ts`.
  const slashCommands =
    overrides.slashCommands ??
    new SlashCommandService({
      authored,
      projectSkillsDir: (projectId) => projectConfig.getConfig(projectId)?.skillsDir,
    });
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
      idleSessionMinutes: config.idleSessionMinutes,
      terminals,
      memory,
      memoryHistory,
      authored,
      slashCommands,
      github,
      runner,
      worktrees,
      // Self-contained `.dispatch/` config: authored agents/modes/
      // instructions (source of truth) resolved config-first, `.data` fallback.
      projectConfig,
      harnesses,
      managerMcp,
      inspect,
      metrics,
      deps: brokerDeps,
    });
  // ONE process-table read, shared by everything below that needs one. The
  // sidebar's count poll and the resource snapshot run on different cadences
  // over identical data; without this they would spawn a `powershell.exe` each,
  // and the feature whose job is to show a loaded machine would be adding to
  // the load. See `ProcTableCache`.
  const procTableCache = overrides.procTableCache ?? new ProcTableCache();

  // What each chat is holding in OS processes, for the count on its sidebar row.
  // Constructed AFTER the broker because the session roots it walks down from
  // are the broker's; `terminals` supplies the other kind of root (background
  // shells, which hang off the SERVER rather than off a session).
  const chatProcesses =
    overrides.chatProcesses ??
    new ChatProcessService({
      procTable: async () => (await procTableCache.read()).rows,
      // Kills read fresh: a cached table can name a pid the OS has recycled.
      procTableFresh: defaultProcTable,
      // A reap has to drop the SHARED table, not just this service's tally —
      // otherwise the Resources page reports the killed processes as an
      // unattributed leak for the rest of the TTL.
      invalidateSource: () => procTableCache.invalidate(),
      sessionPids: () => broker.sessionPids(),
      terminals,
    });

  // What each chat is COSTING, as opposed to how many processes it holds.
  const resources =
    overrides.resources ??
    new ResourceService({
      procTable: procTableCache,
      sessionPids: () => broker.sessionPids(),
      terminals,
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
  // The other end of a worktree's life. The detector notices trees appearing;
  // this removes the ones whose branch has landed and which nothing is standing
  // in — the step of the loop that previously only ever happened when a human
  // noticed the disk filling up. Constructed with the live shell + subApp
  // registries so "a dev server is running out of that directory" is a gate
  // rather than a surprise.
  const worktreeReaper =
    overrides.worktreeReaper ??
    new WorktreeReaper({
      store,
      bus,
      worktrees,
      terminals,
      runners: runner,
      // Read per pass, not at boot: a toggle in Settings has to take effect
      // without a restart, or it reads as broken.
      policy: async () => {
        const s = await store.getSettings();
        return {
          enabled: s.worktreeCleanup?.enabled ?? true,
          deleteBranch: s.worktreeCleanup?.deleteBranch ?? true,
        };
      },
    });
  // Removing a worktree hands its MCP ports back. Assigned here rather than
  // injected because the broker that owns the leases is constructed above this.
  worktrees.mcpPorts = broker.mcpPorts;
  // …and creating one warms its MCP servers, on the port that checkout just
  // leased, so the first tool call in a fresh worktree isn't a cold boot. Taken
  // FROM the broker rather than built here, so the worktree hook and the
  // `prewarm_mcp` tool can never disagree about which port a checkout got.
  worktrees.mcpPrewarm = broker.mcpPrewarm;
  const notifier = overrides.notifier ?? new Notifier({ bus, store });
  // Web Push. The keypair goes in the CONFIG root (shared, and regenerating it
  // would silently invalidate every phone's subscription); the registry goes in
  // the per-instance DATA root, so a dev server never pushes to devices that
  // registered against the installed app. See services/push.ts.
  const push =
    overrides.push ??
    new PushService({
      bus,
      configDir: config.configDir ?? config.dataDir,
      dataDir: config.dataDir,
      onError: (err) => console.error("[Dispatch] web push failed:", err),
    });
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
  // Backs the file explorer (modal picker + full page). Distinct from
  // `fileIndex` on purpose: that one is git-backed and repo-scoped, which is
  // right for "@-mention a file in this project" and useless for "find the CSV
  // on the D: drive".
  const fsExplorer = overrides.fsExplorer ?? new FsExplorerService();
  // Usage-limit auto-resume. Constructed AFTER the broker (it sends through it)
  // and hooked back in below, since a limit is only visible on the broker's
  // errored turn-end. `send` goes through the same lazy session path the routes
  // use — by the time a limit lifts the subprocess is long gone.
  const resume =
    overrides.resume ??
    new ResumeScheduler({
      store,
      bus,
      send: async (chatId, text, parts) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text, { parts });
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
  // The PR catalog: rows for every tracked PR, fed by the one poll body. It owns
  // no timer — the sweep below and `watch_pr` both hand it what they read, which
  // is what keeps the app's picture of a PR and the agent's the same picture.
  const prRegistry =
    overrides.prRegistry ??
    new PrRegistry({
      store,
      bus,
      poll: (repo, number) => github.pollPrState(repo, number),
    });
  // Every `watch_pr` poll lands in the catalog too. An agent watching its PR
  // polls far more tightly than the background sweep can afford to; before this
  // that answer was read once and discarded.
  broker.onPrSnapshot = (chatId, snapshot) => {
    void prRegistry.record(snapshot, { chatId }).catch(() => {});
  };
  // Every PR tool reads the catalog to freeze a card into its result, and
  // `watch_pr` writes back through it to keep the sweep on its fast cadence
  // while an agent is blocked. Repo-agnostic here; the broker binds each
  // session's own owner/name in.
  broker.prRegistry = {
    snapshot: (repo, number) => prRegistry.snapshot(repo, number),
    refresh: (repo, number) => prRegistry.refresh(prRecordKey(repo, number)).then(toPrSnapshot),
    noteWatched: async (repo, number) => {
      await prRegistry.noteWatched(repo, number);
    },
    refreshByThread: async (threadId) => {
      const row = await prRegistry.findByThread(threadId);
      if (!row) return null;
      return toPrSnapshot(await prRegistry.refresh(row.key));
    },
    snapshotByThread: async (threadId) => toPrSnapshot(await prRegistry.findByThread(threadId)),
    reviewAgent: (repo, number) => prRegistry.reviewAgent(repo, number),
    raiseReviewRoundCap: async (repo, number, extra) => {
      await prRegistry.raiseReviewRoundCap(repo, number, extra);
    },
    requestReviewAgent: (repo, number, by) => prRegistry.requestReviewAgent(repo, number, by),
    notePostedReview: (repo, number, by) => prRegistry.notePostedReview(repo, number, by),
    noteReviewRequestError: (repo, number, error) =>
      prRegistry.noteReviewRequestError(repo, number, error),
  };
  const prReviewWatcher =
    overrides.prReviewWatcher ??
    new PrReviewWatcher({
      store,
      bus,
      github: {
        pollPrState: (repo, n) => github.pollPrState(repo, n),
      },
      registry: prRegistry,
      // Open PRs nobody in Dispatch opened. Resolving project → repo → open PRs
      // needs the Store and the GitHub service together, so it lives here rather
      // than widening the watcher's GitHub surface. Best-effort per project: a
      // repo we can't resolve (no remote, no auth) simply contributes nothing.
      discover: async () => {
        const out: Array<{ projectId: string; ref: PRRef }> = [];
        for (const project of await store.listProjects().catch(() => [])) {
          const repo = await github.repoForProject(project).catch(() => null);
          if (!repo) continue;
          const prs = await github.projectOpenPrs(repo).catch(() => []);
          for (const pr of prs) {
            out.push({
              projectId: project.id,
              ref: {
                number: pr.number,
                url: pr.url,
                branch: pr.branch,
                repo,
                title: pr.title,
                state: pr.state,
              },
            });
          }
        }
        return out;
      },
      // Same lazy-session path the ResumeScheduler uses — by the time a review
      // round lands, the chat's subprocess is long gone.
      resume: async (chatId, text, parts) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text, { parts });
      },
      // A chat that's mid-turn is already working (quite possibly inside
      // `watch_pr`); it gets the badge and nothing more.
      isBusy: (chatId) => {
        const status = broker.getStatus(chatId);
        return (
          status === "running" || status === "waiting" || status === "awaiting-input"
        );
      },
      // Dispatch's own reviewer. Resolving the policy needs the project record
      // and spawning needs the whole task launcher, so both live here rather
      // than widening the watcher — which stays a thing that notices, and hands
      // off what to do about it.
      reviewAgent: {
        policyFor: async (projectId) => {
          if (!projectId) return null;
          const project = await store.getProject(projectId).catch(() => null);
          if (!project) return null;
          // Through `resolveReviewer` rather than `resolveWorkflow` directly, so
          // a project asking for a dedicated account it has no credential for
          // comes back DISABLED instead of quietly reviewing as the human.
          //
          // `problem` is handed BACK rather than published as a notice. The
          // sweep asks this per PR every 90 seconds, so a notice here was a
          // toast storm for a standing misconfiguration — and a toast is the
          // wrong shape for it anyway: miss the one you were shown and the
          // reviewer is silently not running. The watcher records it on the PR
          // rows it is costing instead, where it survives a reload.
          const { policy, problem } = await resolveReviewer(store, project);
          return { policy, problem };
        },
        spawn: async ({ projectId, repo, number, round, policy }) => {
          const out = await launchAgentTask(services, {
            projectId,
            taskId: "pr:review",
            effort: policy.effort,
            model: policy.model,
            agentId: policy.agentId,
            params: {
              repo,
              number,
              round,
              maxRounds: policy.maxRounds,
              post: policy.post,
              // The reviewer may block. Which verdicts it can actually reach is
              // GitHub's call in the end — it refuses REQUEST_CHANGES on your
              // own PR — and `submitReview` reports the downgrade rather than
              // hiding it.
              blocking: true,
              houseRules: policy.instructions,
            },
          }).catch(() => null);
          return out ? { chatId: out.chat.id } : null;
        },
      },
    });
  // `create_pr` pre-seeds the watcher so the first sweep after a PR opens can't
  // badge the chat for activity that predates it.
  // Fire-and-forget: arming now reads GitHub, and `create_pr` must not wait on
  // (or fail from) a dedup optimisation. A rejection here is already swallowed
  // inside `arm`; the `.catch` is belt-and-braces against an unhandled rejection.
  broker.armPrWatch = (chatId, ref) => {
    void prReviewWatcher.arm(chatId, ref).catch(() => {});
    // The tracking hook for `create_pr`. Separate from arming because they want
    // different things: arming reads GitHub to SUPPRESS pre-existing activity,
    // this records the row so the PR is in the catalog the instant it is opened
    // — even if that read fails, and even before the first sweep.
    void prRegistry.track(ref, { chatId }).catch(() => {});
    // Ask Dispatch's own reviewer, where the project configured one with no
    // GitHub account to queue. This is `create_pr`'s half of the same request
    // `request_review` makes on later rounds — without it, the first round is
    // the only one nobody asks for, which is precisely the round that matters.
    void (async () => {
      const chat = await store.getChat(chatId).catch(() => null);
      if (!chat?.projectId || !ref.repo) return;
      const project = await store.getProject(chat.projectId).catch(() => null);
      if (!project) return;
      const { policy } = await resolveReviewer(store, project);
      // Only self-review records a LOCAL request: a dedicated account is put in
      // GitHub's own reviewer queue by `create_pr`, and recording a second
      // request here would give the sweep two ways to trigger one review.
      if (!policy.enabled || policy.identity !== "self") return;
      await prRegistry.requestReviewAgent(ref.repo, ref.number, chatId).catch(() => {});
    })();
  };
  // `mcp__dispatch-chat__spawn_chat`: an agent starting ANOTHER chat, after the human
  // approved it (the broker asks; this only runs once they said yes). Deliberately
  // the SAME `createChat` → `ensureSession` → `sendMessage` path a human's "New
  // chat" takes, so a spawned chat is an ordinary chat in every respect — same
  // project defaults, worktree isolation, workflow profile and guards. The purpose
  // tag is the only difference, and it exists so the sidebar can say where the
  // chat came from.
  // The reviewer identity for a session — the policy joined to the app-wide
  // credential. A function on the broker rather than a Store reach-in, so the
  // broker keeps knowing nothing about where credentials are kept.
  broker.resolveReviewer = async (projectId) => {
    if (!projectId) return null;
    const project = await store.getProject(projectId).catch(() => null);
    return project ? resolveReviewer(store, project) : null;
  };
  // Chat-to-chat messaging (`chat_send`/`chat_ask`/`chat_reply`/`chat_state`),
  // and the substrate the Mission layer is meant to be built on. Constructed
  // here rather than inside the broker for the same reason `spawnChat` is
  // assigned here: reaching a chat that has FINISHED means rebuilding its
  // session through the routes' `ensureSession`, which needs the whole
  // container.
  const chatMessenger =
    overrides.chatMessenger ??
    new ChatMessenger({
      bus,
      getChat: (chatId) => store.getChat(chatId).catch(() => null),
      ensureSession: async (chatId) => {
        await ensureSession(services, chatId);
      },
      getStatus: (chatId) => broker.getStatus(chatId),
      // The broker's OWN send path, so a peer message is an ordinary turn in
      // every respect but its attribution — same row, same outbox, same
      // steering semantics as anything the human types.
      send: (chatId, text, { peer }) => broker.sendMessage(chatId, text, { peer }),
      // Raw usage, not a pre-rounded percentage: the messenger derives one
      // itself for the harnesses that report only totals.
      getContextUsage: (chatId) => broker.getContextUsage(chatId),
      // `awaiting-input` is the status a chat sits in while a permission card or
      // a question is open in front of the human — the one thing a project
      // manager most needs to know it cannot fix by waiting.
      isBlockedOnHuman: (chatId) => broker.getStatus(chatId) === "awaiting-input",
    });
  broker.messenger = chatMessenger;
  broker.spawnChat = async ({ request, project, parentChatId }) => {
    const chat = await createChat(services, {
      projectId: project.id,
      title: request.title,
      modeId: request.modeId,
      agentId: request.agentId,
      effort: request.effort,
      model: request.model,
      // Built in shared, beside the parser that reads it back — the detached form
      // deliberately does NOT match that parser, and two prose literals in two
      // packages would only agree by luck. See `spawnedPurposeLabel`.
      purpose: { kind: "spawned", label: spawnedPurposeLabel(parentChatId, request.detached) },
      // The DURABLE parent edge, which the purpose label above is not: that
      // label is a display sentence, and the sidebar reading a parent id back
      // out of prose is a legacy path, not a design. Omitted when the agent
      // asked to detach — see `SpawnChatRequest.detached`.
      ...(request.detached ? {} : { parentChatId }),
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
  let offReap: (() => void) | undefined;
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
    authored,
    slashCommands,
    memoryCommitter,
    memoryHistory,
    projectConfig,
    projectConfigArchive,
    inspect,
    title,
    checkpoints,
    worktrees,
    worktreeDetector,
    worktreeReaper,
    git,
    commitMessage,
    runner,
    processes,
    chatProcesses,
    procTableCache,
    resources,
    github,
    notifier,
    push,
    attention,
    usage,
    release,
    resume,
    chatMessenger,
    fileIndex,
    fsExplorer,
    metrics,
    metricsBackfill,
    trunkSync,
    prReviewWatcher,
    prRegistry,

    async start(): Promise<void> {
      // This runs before clients hydrate. Graceful shutdowns have already
      // persisted `done`; only a killed/crashed process leaves a live status.
      await recoverInterruptedChatStatuses(store).catch((err) => {
        console.error("[Dispatch] chat status recovery failed (continuing):", err);
      });

      // The concurrency cap is an app SETTING; `config.maxActiveSessions` (the
      // env var) is only its default. Applied here rather than in the broker's
      // constructor because reading it is async and `buildServices` is not —
      // and `start()` still runs before the server listens, so no turn can be
      // admitted against the boot default first.
      await store
        .getSettings()
        .then((s) => {
          broker.setCap(s.maxActiveSessions);
          broker.setIdleTimeout(s.idleSessionMinutes);
        })
        .catch(() => {
          /* best-effort: an unreadable config leaves the env/default cap in force */
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
      // The usage ledger's flush timer. Rows buffer whether or not it is armed,
      // so nothing is lost before this — it only decides how promptly the buffer
      // reaches the disk.
      safeStart("metrics", () => metrics.start());
      // Reconstruct history from the transcripts, ONCE (see MetricsBackfill
      // for the three guards). Deliberately not awaited: on a long-lived install
      // this walks every chat that ever existed, and boot must not wait for it.
      void metricsBackfill.run().then(
        (r) => {
          if (r.ran) {
            console.log(
              `[Dispatch] metrics: imported ${r.rows} row(s) from ${r.chats} chat(s).`,
            );
          }
        },
        (err: unknown) => console.error("[Dispatch] metrics backfill failed:", err),
      );

      safeStart("attention", () => attention.start());
      safeStart("memoryCommitter", () => memoryCommitter.start());
      safeStart("notifier", () => notifier.start());
      safeStart("push", () => push.start());
      // Subscription usage polling (a missing token / offline just yields an
      // "unavailable" snapshot the header meter hides on).
      safeStart("usage", () => usage.start());
      // Release polling. A no-op unless this payload came from a release, and
      // its first check is deferred so an unreachable GitHub delays no boot.
      // Hydrate the channel FIRST — a check that ran before the subscription
      // loaded would ask the stable endpoint on behalf of an unstable install.
      await release.hydrate().catch(() => {});
      safeStart("release", () => release.start());
      // Seed the PR catalog from every chat's `Chat.prs` BEFORE the sweep runs,
      // so PRs opened before this catalog existed appear with nobody doing
      // anything. No GitHub calls — the rows come from the pointers a chat
      // already holds, and the first sweep fills in live state.
      await prRegistry.backfill().catch((err: unknown) => {
        console.error("[Dispatch] PR catalog backfill failed (continuing):", err);
      });
      // Notices review rounds on PRs chats own — the half of the loop that
      // doesn't require an agent to keep asking — and keeps the catalog current.
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

      // Worktree cleanup, on two triggers that share one gate.
      //
      // The hourly sweep is the backstop — it catches trees whose owning chat
      // never came back, and drains a backlog a few at a time (its probe is the
      // expensive part; see WorktreeReaper's cost model).
      //
      // The chat-idle sweep is the one you actually feel: the moment a turn
      // ends, that chat's own landed worktrees go. It is deliberately NOT
      // wired to the merge itself — `approve_pr` runs mid-turn with the agent's
      // cwd inside the very tree that just became disposable, so removing it
      // there would pull the floor out from under a live session.
      // Both triggers are armed unconditionally; the reaper's own `policy` hook
      // decides at fire time whether cleanup is on. Gating the WIRING on the
      // setting would mean enabling it in Settings did nothing until a restart.
      worktreeReaper.start(WORKTREE_SWEEP_MS);
      offReap = bus.on("chat-status", (evt) => {
        if (evt.status !== "idle" && evt.status !== "done") return;
        void worktreeReaper.sweepChat(evt.chatId).catch(() => {});
      });
    },

    async dispose(): Promise<void> {
      offCheckpoint?.();
      offCheckpoint = undefined;
      offTitle?.();
      offTitle = undefined;
      offReap?.();
      offReap = undefined;
      worktreeReaper.stop();
      // Let an in-flight sweep land rather than tearing the store out from
      // under a removal that is halfway through updating the registry.
      await worktreeReaper.drain().catch(() => {});
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
      push.stop();
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
      // Releases every chat blocked in `chat_ask`. Before the broker goes away,
      // so a waiting session is told the answer is not coming rather than
      // hanging on a promise nothing is left to resolve.
      chatMessenger.dispose();
      await runner.stopAll().catch(() => {});
      await broker.dispose().catch(() => {});
      await harnesses.dispose().catch(() => {});
      // AFTER the broker: it is the thing still recording, and disarming the
      // flush earlier would strand the last turn's rows in the buffer. This only
      // flushes + disarms — the database handle belongs to `Store`, which closes
      // it in its own teardown.
      metrics.dispose();
      if (terminalSweep) clearInterval(terminalSweep);
      terminalSweep = undefined;
      // Kill any lingering persistent shells after the broker unwinds — flushing
      // their queued output first, because the tail of a transcript is usually
      // the part that explains why anyone is reading it.
      //
      // Normally a no-op by the time we get here: `installShutdown` reaps the
      // shells BEFORE `app.close()` precisely because this position — last,
      // behind three slower awaits, inside a 20s grace window — is the one that
      // gets cut off and leaves a dev server holding its port. This stays for
      // the teardowns that don't come through there (a test's `dispose()`, an
      // embedded server), and `reap()` is idempotent.
      await terminals.reap().catch(() => {});
    },
  };

  return services;
}

/**
 * A catalog row reduced to the display half a PR tool freezes into its result.
 *
 * Null-tolerant because every caller here is best-effort: a PR the catalog has
 * never seen yields no card, never an error on a tool that otherwise worked.
 */
function toPrSnapshot(row: PrRecord | null): PrSnapshot | null {
  return row ? PrSnapshotSchema.parse(row) : null;
}
