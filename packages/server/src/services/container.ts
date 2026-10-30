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
  findSubscription,
  pinnedIdOf,
  PrSnapshotSchema,
  prRecordKey,
  resolveAgentContext,
  resolveWorkflow,
  spawnedPurposeLabel,
  type PRRef,
  type PrRecord,
  type PrSnapshot,
  expandSecretsOnly,
  realProjects,
} from "@dispatch/shared";
import { launchAgentTask } from "./agent-tasks.js";
import { SecretsService } from "./secrets.js";
import { SecretRefresher } from "./secret-refresh.js";
import { resolveReviewer } from "./reviewer.js";
import type { EventBus } from "../bus.js";
import { createChat, ensureSession } from "../routes/dispatch.js";
import { ChatMessenger } from "./chat-messenger.js";
import { createIntegrationContext } from "./mcp/integration-context.js";
import { personasFor } from "./personas.js";
import { ChannelChatService } from "./channel-chats.js";
import { ChatSummaryService } from "./chat-summary.js";
import { ChatCompletionNotices } from "./chat-completion-notice.js";
import { SessionBroker } from "./session-broker.js";
import { TerminalService } from "./terminal.js";
import { TerminalBackendRegistry } from "./terminal-backends.js";
import { MemoryService } from "./memory.js";
import { AuthoredConfigService } from "./authored-config.js";
import { HouseRulesService, houseRulesDirFor } from "./house-rules.js";
import { ClaudeMemoryService } from "./claude-memory.js";
import { SlashCommandService } from "./slash-commands.js";
import { MemoryCommitter } from "./memory-committer.js";
import { MemoryHistoryService } from "./memory-history.js";
import { ProjectConfigService } from "./project-config.js";
import { ProjectConfigArchive } from "./project-config-archive.js";
import { InspectService, installedRoots } from "./inspect.js";
import { TitleService, makeFakeTitleGenerator } from "./title.js";
import { CheckpointService } from "./checkpoint.js";
import { WorktreeService } from "./worktree.js";
import { WorktreeDetector } from "./worktree-detector.js";
import { WorktreeReaper } from "./worktree-reaper.js";
import { RetentionService } from "./retention.js";
import { deleteChat, reapChatResidual } from "./chat-deletion.js";
import { GitService } from "./git.js";
import { GrowthService } from "./growth.js";
import { CommitMessageService, makeFakeCommitGenerator } from "./commit-message.js";
import { RunnerService } from "./runner.js";
import { ProcessService, defaultProcTable } from "./processes.js";
import { ChatProcessService } from "./chat-processes.js";
import { ProcTableCache } from "./proc-table-cache.js";
import { ResourceService } from "./resources.js";
import { GitHubService } from "./github.js";
import { CiService } from "./ci.js";
import { IssueService } from "./issues/service.js";
import { IssueWatcher } from "./issue-watcher.js";
import { Notifier } from "./notifier.js";
import { WebhookService } from "./webhooks.js";
import { EventFeedService } from "./event-feed.js";
import { PushService } from "./push.js";
import { AttentionQueue } from "./attention.js";
import { HomeService } from "./home.js";
import { snapshotOfLimits } from "./usage-read.js";
import { chatSubscription } from "./subscriptions.js";
import { ReleaseService } from "./release.js";
import { ResumeScheduler } from "./resume-scheduler.js";
import { FailoverService } from "./failover.js";
import { RestartResumeService } from "./restart-resume.js";
import { PauseService } from "./pause.js";
import { TrunkSyncService } from "./trunk-sync.js";
import { PrReviewWatcher } from "./pr-review-watcher.js";
import { PrRegistry } from "./pr-registry.js";
import { chatNestingDepth } from "./chat-nesting.js";
import { chatFamily, memoizedChatLister, chatTree, type ChatTreeDeps } from "./chat-tree.js";
import { FileIndexService } from "./file-index.js";
import { MetricsService } from "./metrics.js";
import { MetricsBackfill } from "./metrics-backfill.js";
import { TokenLedger } from "./metrics-tokens.js";
import { TokenBackfill } from "./metrics-tokens-backfill.js";
import { LimitLedger } from "./limit-ledger.js";
import { LimitSampler } from "./limit-sampler.js";
import { FsExplorerService } from "./fs-explorer.js";
import { HarnessRegistry } from "../harness/index.js";
import { ProviderLogins } from "./provider-logins.js";
import { ManagerMcpBridge } from "./mcp/manager-http.js";
import { PluginService } from "../plugins/service.js";
import { findShippedPluginsRoot } from "../plugins/shipped.js";
import { PluginInspector } from "../plugins/inspect/index.js";
import { PluginUpdateWatcher, pluginUpdateHours } from "../plugins/inspect/watcher.js";
import { PluginOAuthService } from "../plugins/oauth.js";
import { PluginCleanupQueue } from "../plugins/cleanup.js";

/** The shared base every service hangs off. */
export interface ServiceBase {
  config: ServerConfig;
  store: Store;
  bus: EventBus;
}

/** Injectable service overrides (tests supply fakes; prod omits them). */
export interface ServiceOverrides {
  secrets?: SecretsService;
  issues?: IssueService;
  harnesses?: HarnessRegistry;
  logins?: ProviderLogins;
  managerMcp?: ManagerMcpBridge;
  broker?: SessionBroker;
  terminals?: TerminalService;
  terminalBackends?: TerminalBackendRegistry;
  memory?: MemoryService;
  authored?: AuthoredConfigService;
  houseRules?: HouseRulesService;
  claudeMemory?: ClaudeMemoryService;
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
  retention?: RetentionService;
  git?: GitService;
  growth?: GrowthService;
  commitMessage?: CommitMessageService;
  runner?: RunnerService;
  processes?: ProcessService;
  chatProcesses?: ChatProcessService;
  procTableCache?: ProcTableCache;
  resources?: ResourceService;
  github?: GitHubService;
  ci?: CiService;
  notifier?: Notifier;
  webhooks?: WebhookService;
  eventFeed?: EventFeedService;
  push?: PushService;
  attention?: AttentionQueue;
  home?: HomeService;
  release?: ReleaseService;
  resume?: ResumeScheduler;
  failover?: FailoverService;
  restartResume?: RestartResumeService;
  fileIndex?: FileIndexService;
  metrics?: MetricsService;
  metricsBackfill?: MetricsBackfill;
  tokens?: TokenLedger;
  fsExplorer?: FsExplorerService;
  trunkSync?: TrunkSyncService;
  prReviewWatcher?: PrReviewWatcher;
  issueWatcher?: IssueWatcher;
  prRegistry?: PrRegistry;
  chatMessenger?: ChatMessenger;
  chatCompletionNotices?: ChatCompletionNotices;
  plugins?: PluginService;
  pluginInspector?: PluginInspector;
  pluginUpdates?: PluginUpdateWatcher;
  pluginOAuth?: PluginOAuthService;
}

/** Everything the routes/WS layer needs, wired to one bus + store. */
export interface Services extends ServiceBase {
  /** Installed agent runtimes and their capability/model catalogues. */
  harnesses: HarnessRegistry;
  /** Cached login state per provider account — what `logged-out` is judged by. */
  logins: ProviderLogins;
  /** HTTP front door used by runtimes that cannot consume in-process MCP. */
  managerMcp: ManagerMcpBridge;
  broker: SessionBroker;
  /** Encrypted app-wide + per-project secrets behind `${secret:NAME}`. */
  secrets: SecretsService;
  /** Which tracker a project's issues live in, and a provider-neutral handle on it. */
  issues: IssueService;
  /** Pushes a changed secret through config, live chats and running sub-apps. */
  secretRefresher: SecretRefresher;
  terminals: TerminalService;
  /** Plugin-supplied places for those shells to run, and the ports they forward (#414). */
  terminalBackends: TerminalBackendRegistry;
  memory: MemoryService;
  /** App-level (shipped + user-global) instructions and skills. */
  authored: AuthoredConfigService;
  /** The human's always-on, size-capped house rules (global + per project). */
  houseRules: HouseRulesService;
  /** Claude Code's own auto-memory dir for a project, surfaced for curation. */
  claudeMemory: ClaudeMemoryService;
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
  /** Deletes stale checkpoints, settled reviewer chats and old tool-output images. */
  retention: RetentionService;
  /** Working-copy git (status/stage/commit/branch/stash) for the Source Control UI. */
  git: GitService;
  /** The Growth tab's on-demand `git log --numstat` walk. Stateless, no cache. */
  growth: GrowthService;
  /** One-shot AI commit messages drafted from the staged diff. */
  commitMessage: CommitMessageService;
  runner: RunnerService;
  processes: ProcessService;
  /** Per-chat process totals for the sidebar, and the manual reap behind them. */
  chatProcesses: ChatProcessService;
  procTableCache: ProcTableCache;
  resources: ResourceService;
  github: GitHubService;
  /** The CI/CD page's provider-neutral read/act layer (GitHub Actions today). */
  ci: CiService;
  notifier: Notifier;
  /** Signed outbound POSTs of bus events to subscribed URLs; see services/webhooks.ts. */
  webhooks: WebhookService;
  /** The durable "what happened" log integrations poll; see services/event-feed.ts. */
  eventFeed: EventFeedService;
  /** Server-sent Web Push — the only delivery path an iOS home-screen app has. */
  push: PushService;
  attention: AttentionQueue;
  /** The cross-project overview behind the homepage. */
  home: HomeService;
  /** Knows whether a newer Dispatch release exists, and can launch the installer. */
  release: ReleaseService;
  /** Schedules a chat to continue itself once a usage limit lifts. */
  resume: ResumeScheduler;
  /** Account failover on a usage limit. See services/failover.ts. */
  failover: FailoverService;
  /** Continues chats a deliberate restart (usually an update) cut short. */
  restartResume: RestartResumeService;
  /** The global pause/resume control. See services/pause.ts. */
  pause: PauseService;
  /** Chats an integration starts (`spawn_chat` on the external mount, `POST /api/integration/chats`). */
  channelChats: ChannelChatService;
  /** `chat_summarize` / `GET /api/integration/chats/:id/summary`. */
  chatSummaries: ChatSummaryService;
  /** Chat-to-chat messaging behind `chat_send`/`chat_ask`/`chat_reply`/`chat_state`. */
  chatMessenger: ChatMessenger;
  chatCompletionNotices: ChatCompletionNotices;
  /** Installed plugins under `<configDir>/plugins/`: discovery, activation, their route tables. */
  plugins: PluginService;
  /** Settings → Plugins → Inspect from URL: read a plugin at a git URL without running it, and install that exact sha. */
  pluginInspector: PluginInspector;
  /** Background update checks for git-installed plugins, and the `auto` policy. */
  pluginUpdates: PluginUpdateWatcher;
  /** The host-run OAuth client flow behind `ctx.oauth` and the plugin pane's Connect button. */
  pluginOAuth: PluginOAuthService;
  fileIndex: FileIndexService;
  /** The SQLite usage ledger behind the Metrics view. */
  metrics: MetricsService;
  /** The one-time transcript import that gives that view history on day one. */
  metricsBackfill: MetricsBackfill;
  /** Tokens and cost per turn × model × account — Metrics → Tokens. */
  tokens: TokenLedger;
  /** Every account's limit windows over time, and their resets — Metrics → Limits. */
  limits: LimitLedger;
  /** The one schedule that reads every account's limits into {@link limits}. */
  limitSampler: LimitSampler;
  /** Directory listings, stats, drives/mounts and writes for the file explorer. */
  fsExplorer: FsExplorerService;
  /** Fast-forwards a project's primary checkout after its PRs land. */
  trunkSync: TrunkSyncService;
  /** Raises `review` attention (and wakes the owning chat) on PR activity. */
  prReviewWatcher: PrReviewWatcher;
  /** Polls enrolled projects' trackers and starts a chat per batch of new issues. */
  issueWatcher: IssueWatcher;
  /** The tracked-PR catalog — the Workspace view's third registry. */
  prRegistry: PrRegistry;
  /** Start background wiring (attention, notifier, auto-checkpoint). Bounded. */
  start(): Promise<void>;
  /**
   * The rest of boot — the part whose cost scales with the install. Called from
   * `start.ts` AFTER `app.listen()`, never from `buildApp()`: awaiting it with
   * the port shut is what made the updater roll healthy builds back. Memoised
   * and never rejects.
   */
  warm(): Promise<void>;
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
  // Empty until the provider plugins register in `start()`. The
  // `DISPATCH_FAKE_SDK=1` echo the E2E runs on lives in the Claude plugin
  // itself (`createClaudeHarness`), the one place a `ClaudeHarness` is built.
  const harnesses = overrides.harnesses ?? new HarnessRegistry();
  // Login state per provider account, cached so a turn never waits on a probe.
  // A flip in whether a chat may run is announced like a plugin toggle, so an
  // open composer's "not logged in" banner appears or clears by itself.
  const logins =
    overrides.logins ??
    new ProviderLogins({
      harnesses,
      settings: () => store.getSettings(),
      onChange: () => bus.publish({ type: "providers-changed" }),
    });
  const managerMcp =
    overrides.managerMcp ?? new ManagerMcpBridge(`http://127.0.0.1:${config.port}`);
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
  //
  // Where they run is the `terminals` plugin capability's business: with no
  // backend registered the registry is empty and every shell is local, exactly
  // as before. The closures read `projectConfig` lazily — it is constructed a
  // few lines below, and nothing calls them before a plugin has activated.
  // Plugin cleanups that failed — today a backend's `onChatDeleted` — kept in
  // state.db and retried until they succeed. Its executor names the registry
  // below lazily; nothing runs a row before `start()` arms the timer.
  const pluginCleanups = new PluginCleanupQueue({
    db: store.stateDb,
    run: (row) => terminalBackends.runChatDeleted(row.target, { chatId: row.chatId, projectId: row.projectId }),
    log: (message, err) => console.warn(`[plugins] ${message}`, err ?? ""),
  });
  const terminalBackends: TerminalBackendRegistry =
    overrides.terminalBackends ??
    new TerminalBackendRegistry({
      cleanups: pluginCleanups,
      bus,
      chat: async (chatId) => {
        const chat = await store.getChat(chatId).catch(() => null);
        return chat ? { terminalBackend: chat.terminalBackend, projectId: chat.projectId } : null;
      },
      projectDefault: (projectId) => projectConfig.getDefaults(projectId)?.terminalBackend,
      // Both layers raw; `resolveTerminalLocations` decides which one speaks.
      allowedLocations: async (projectId) => ({
        project: projectId ? projectConfig.getDefaults(projectId)?.terminalLocations : undefined,
        app: (await store.getSettings().catch(() => null))?.terminalLocations,
      }),
      repoPath: async (projectId) => (await store.getProject(projectId).catch(() => null))?.repoPath,
      log: (message, err) => console.warn(`[terminals] ${message}`, err ?? ""),
      // `plugins` is assigned further down; only called once a chat opens a shell.
      settled: () => plugins.activationSettled(),
    });
  const terminals =
    overrides.terminals ?? new TerminalService({ bus, store, backends: terminalBackends });
  // A backend whose plugin goes away takes the transport its shells ride on
  // with it; end them now so the next command re-resolves instead of writing
  // into a dead channel.
  terminalBackends.onDetach((id) => terminals.detachBackend(id));
  // Self-contained project config: discovers + validates the authored config for
  // a managed project — the repo's committed `.dispatch/` or the install-owned
  // dir, resolved per project by `config-location.ts` — syncs it into the
  // project store (authored overrides `.data`), and watches it for live reload.
  // A project with no config dir anywhere falls back to the `.data` store
  // untouched (back-compat). Constructed before `memory` so it can point a
  // config-dir project's memory at that config's `memory/`.
  // The usage ledger. Constructed before the broker because the broker RECORDS
  // into it; per-instance (it lives in `.data`, never the shared `config/`) for
  // the same reason `runners.json` is — two processes writing one SQLite file
  // over a shared/network path is a corruption story nobody needs.
  const metrics = overrides.metrics ?? new MetricsService({ db: store.stateDb });
  const metricsBackfill =
    overrides.metricsBackfill ?? new MetricsBackfill({ store, metrics });
  const tokens = overrides.tokens ?? new TokenLedger(store.stateDb);
  const tokenBackfill = new TokenBackfill({ store, metrics, tokens });
  // Secrets live in the CONFIG root beside reviewer.json, so both instances
  // resolve the same `${secret:NAME}`. Constructed before project config, which
  // expands them into MCP server definitions at load.
  const secrets =
    overrides.secrets ?? new SecretsService({ configDir: config.configDir ?? config.dataDir });
  const projectConfig =
    overrides.projectConfig ?? new ProjectConfigService({ store, bus, secrets });
  // Per-project durable agent memory: injected at session start + exposed to the
  // agent as `mcp__dispatch-memory__remember|recall|forget`, and curated in the UI. Reads
  // from the project config dir's `memory/` when it has one (source of truth),
  // else the `.data` store (back-compat) — which for the default EXTERNAL
  // placement is the same directory either way.
  const memory =
    overrides.memory ?? new MemoryService({ store, bus, projectConfig });
  // App-level authored guidance: Dispatch's own shipped instructions + skills,
  // and the operator's machine-wide ones under `<config>/global/`. Also the
  // write surface behind `mcp__dispatch-config__config_write`. Both scopes are
  // read on every session launch, so it is constructed once and shared.
  const authored =
    overrides.authored ?? new AuthoredConfigService({ globalRoot: store.globalConfigDir() });
  // Project house rules sit in the same dir as the project's config — its
  // `.dispatch/` when it has one, else the external config dir — so they travel
  // with the instructions they sit above. See `houseRulesDirFor` for why this
  // doesn't go through the parsed config.
  /**
   * What rides on every turn, resolved project-over-app. One closure, shared by
   * the house-rules service and the broker's memory surfacing, so the two can't
   * disagree about which project raised what.
   *
   * Reads the settings PER CALL rather than closing over a snapshot: these are
   * edited while chats are running, and a cap captured at boot would keep
   * refusing writes the human had already allowed.
   */
  const agentContextFor = async (projectId?: string) => {
    const settings = await store.getSettings().catch(() => null);
    return resolveAgentContext(
      settings?.agentContext,
      projectId ? projectConfig.getAgentContext(projectId) : null,
    );
  };
  const houseRules =
    overrides.houseRules ??
    new HouseRulesService({
      globalRoot: store.globalConfigDir(),
      projectDir: async (projectId) =>
        houseRulesDirFor(
          await store.getProject(projectId).catch(() => null),
          store.projectConfigDir(projectId),
        ),
      agentContext: agentContextFor,
    });
  const claudeMemory = overrides.claudeMemory ?? new ClaudeMemoryService();
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
  const ci =
    overrides.ci ?? new CiService({ resolveRepo: (project) => github.repoForProject(project) });
  const issues =
    overrides.issues ??
    new IssueService({
      getProject: (id) => store.getProject(id),
      getConfig: (id) => projectConfig.getIssues(id),
    });
  // Worktrees + subApp runner are constructed BEFORE the broker so the session
  // MCP's `run_subapp` tool can launch apps (and resolve/create worktrees).
  const worktrees = overrides.worktrees ?? new WorktreeService({ bus, store });
  // Working-copy git for the Source Control view. Stateless (every call is
  // scoped to a `repoPath` the route passes), so it needs no bus/store wiring.
  const git = overrides.git ?? new GitService();
  const growth = overrides.growth ?? new GrowthService();
  const commitMessage =
    overrides.commitMessage ??
    new CommitMessageService({
      git,
      harnesses,
      settings: () => store.getSettings(),
      generateText: process.env.DISPATCH_FAKE_SDK === "1" ? makeFakeCommitGenerator() : undefined,
    });
  const runner =
    overrides.runner ??
    new RunnerService({
      store,
      bus,
      expandSecrets: (projectId, value) => expandSecretsOnly(value, secrets.resolverFor(projectId)),
    });
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
      logins,
      maxActiveSessions: config.maxActiveSessions,
      idleSessionMinutes: config.idleSessionMinutes,
      terminals,
      terminalBackends,
      memory,
      secrets,
      issues,
      // Built below, after the broker it depends on; only ever called from a tool.
      secretRefresher: (): SecretRefresher => secretRefresher,
      memoryHistory,
      authored,
      houseRules,
      agentContext: agentContextFor,
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
      tokens,
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
  // Removing a worktree retires the checkpoints taken in it — the one removal
  // path the reaper, the UI and the `worktree` tool all share.
  worktrees.checkpoints = checkpoints;
  // What nothing else ever deletes. `deleteChat` is the route's own full path,
  // late-bound through `services` like `ensureSession` above.
  const retention =
    overrides.retention ??
    new RetentionService({
      store,
      checkpoints,
      deleteChat: (chatId) => deleteChat(services, chatId),
      isBusy: (chatId) => {
        const status = broker.getStatus(chatId);
        return (
          status === "running" ||
          status === "waiting" ||
          status === "awaiting-input" ||
          status === "queued"
        );
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
  // Outbound webhooks. Same seam as the notifier — a bus consumer whose only
  // side effect is an HTTP POST — plus the completion notice's settle rule for
  // the derived `chat-settled`, which is why it reads the broker's live status
  // and pending work rather than trusting the raw `idle` edge.
  const webhooks =
    overrides.webhooks ??
    new WebhookService({
      bus,
      store,
      getStatus: (chatId) => broker.getStatus(chatId),
      hasPendingWork: (chatId) =>
        broker.hasPendingWork(chatId) || chatMessenger.hasPending(chatId),
    });
  // The integration event feed: the pull-side twin of the webhooks, for a
  // connector that can only make tool calls. Same settle inputs, same reason.
  const eventFeed =
    overrides.eventFeed ??
    new EventFeedService({
      bus,
      db: store.stateDb,
      store,
      getStatus: (chatId) => broker.getStatus(chatId),
      hasPendingWork: (chatId) =>
        broker.hasPendingWork(chatId) || chatMessenger.hasPending(chatId),
    });
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
  // The homepage rollup. Reads the ledger and the (already in-memory) chat
  // records; spawns nothing. See `home.ts` for why it is cached rather than
  // computed per request.
  const home = overrides.home ?? new HomeService({ store, metrics, attention });
  // Limit history, and the header meter's live feed. Every provider that
  // declares `usageLimits` is read on one adaptive schedule through
  // `Harness.readLimits`, and each good read fans out to every tab as
  // `usage-update` — one read per account, however many tabs are open. There
  // is no Claude poller here any more: it is the Claude harness's own, so an
  // install that never uses Claude never calls Anthropic (#425).
  const limits = new LimitLedger(store.stateDb);
  const limitSampler = new LimitSampler({
    ledger: limits,
    harnesses,
    settings: () => store.getSettings(),
    onRead: (sub, read) => bus.publish({ type: "usage-update", usage: snapshotOfLimits(sub, read) }),
  });
  // A turn that just spent from an account is the best reason to look at that
  // account's windows again; the sampler's floor keeps it to one read per
  // five minutes however many turns run.
  tokens.onRecord = (lines) => {
    for (const id of new Set(lines.map((l) => l.subscriptionId))) limitSampler.nudge(id);
  };
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
  // Falling back to another login when one runs out, which the scheduler
  // prefers over waiting a window out. `switchTo` is the broker's own account
  // move — the one the composer's account picker calls — so a failover and a
  // hand switch cannot diverge in how they carry (or hand off) the session.
  const failover =
    overrides.failover ??
    new FailoverService({
      store,
      bus,
      harnesses,
      switchTo: (chatId, subscriptionId) => broker.setSubscription(chatId, subscriptionId),
    });
  const resume =
    overrides.resume ??
    new ResumeScheduler({
      store,
      bus,
      send: async (chatId, text, parts) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text, { parts });
      },
      failover: (chatId, reason, resetsAt) => failover.onLimit(chatId, reason, resetsAt),
    });
  broker.onTurnError = (chatId, reason, hit) => {
    void resume.onTurnError(chatId, reason, hit).catch(() => {});
  };
  // Auto-resume across a DELIBERATE restart — an update, `app:stop`, Settings →
  // Stop. Same lazy-session `send` as above for the same reason. `interrupt`
  // rather than `stop` backs the undo button: taking back a continuation we sent
  // must not also tear down a session the human may now want to steer by hand.
  const restartResume =
    overrides.restartResume ??
    new RestartResumeService({
      store,
      bus,
      send: async (chatId, text, opts) => {
        await ensureSession(services, chatId);
        await broker.sendMessage(chatId, text, opts ?? {});
      },
      interrupt: async (chatId) => {
        await broker.interrupt(chatId);
      },
    });
  const pause = new PauseService({
    broker,
    file: store.pauseFile(),
    // Intersected with THIS instance's chats. The process scan is machine-wide
    // and attributes by a per-chat marker, so its tally includes the chats of the
    // other instance running beside this one — a dev build's Pause must not reach
    // over and kill stable's shells. Seen on the first live run of this.
    chatsWithProcesses: async () => {
      const [counts, chats] = await Promise.all([chatProcesses.counts(), store.listChats()]);
      const mine = new Set(chats.map((c) => c.id));
      return Object.keys(counts.byChat).filter((id) => mine.has(id));
    },
    // The same three steps as `POST /api/chats/processes/kill`, except that the
    // session stop keeps what is queued behind the pause — see
    // `stopKeepingQueued` for why a plain `stop()` would lose it.
    killChat: async (chatId) => {
      await broker.stopKeepingQueued(chatId).catch(() => {});
      terminals.killChat(chatId);
      await reapChatResidual({ chatProcesses, processes }, chatId).catch(() => {});
    },
    afterKill: async (ids) => {
      for (let i = 0; i < 20; i++) {
        chatProcesses.invalidate();
        const { byChat } = await chatProcesses.counts();
        if (!ids.some((id) => id in byChat)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      chatProcesses.invalidate();
    },
    send: async (chatId, text, opts) => {
      await ensureSession(services, chatId);
      await broker.sendMessage(chatId, text, opts);
    },
  });
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
    // BOUND, not re-wrapped. The hand-written arrow dropped the options
    // argument the day one was added — and silently, because a function of
    // fewer parameters is assignable to one of more, so the fresh round cap
    // `request_review` computes was discarded here while every type checked.
    // Binding forwards whatever the interface grows next by construction.
    requestReviewAgent: prRegistry.requestReviewAgent.bind(prRegistry),
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
        for (const project of realProjects(await store.listProjects().catch(() => []))) {
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
          // The project's OWN effort pin, not `policy.effort`: the resolved value
          // is never empty (it bottoms out at the profile's "high"), so passing it
          // would shadow the app's per-provider reviewer default every time.
          // Unpinned, `launchAgentTask` walks provider default → task default.
          const project = await store.getProject(projectId).catch(() => null);
          const out = await launchAgentTask(services, {
            projectId,
            taskId: "pr:review",
            // `?? undefined`: the field is nullable on the wire (null = "clear
            // this pin"), and both spellings mean the same thing here — let
            // `launchAgentTask` walk provider default → task default.
            effort: project?.workflow?.pr?.reviewAgent?.effort ?? undefined,
            harness: policy.harness,
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
  const issueWatcher =
    overrides.issueWatcher ??
    new IssueWatcher({
      store,
      bus,
      configFor: (projectId) => projectConfig.getIssues(projectId),
      trackerFor: (projectId) => issues.forProject(projectId),
      chatExists: async (chatId) => !!(await store.getChat(chatId).catch(() => null)),
      // Only the INSTALLED app polls. Stable and dev share config/ (both would
      // see a project enrolled) but not data/ (neither sees the other's
      // claims), so a dev checkout polling too would race stable for every
      // issue. `release.supported` is "this payload came from a release", which
      // is exactly the installed/dev line. The env var is the escape hatch for
      // exercising the watcher from a checkout on purpose.
      active: () => {
        const forced = process.env.DISPATCH_ISSUE_WATCHER;
        if (forced === "1" || forced === "true") return true;
        if (forced === "0" || forced === "false") return false;
        return release.supported;
      },
      spawn: async ({ projectId, issues: batch, policy, sourceLabel }) => {
        const out = await launchAgentTask(services, {
          projectId,
          taskId: "issue:handle",
          effort: policy.effort,
          harness: policy.harness,
          model: policy.model,
          agentId: policy.agentId,
          personaId: policy.personaId,
          params: {
            issues: batch,
            mode: policy.mode,
            sourceLabel,
            claimLabel: policy.claimLabel,
            houseRules: policy.instructions,
          },
        }).catch(() => null);
        return out ? { chatId: out.chat.id } : null;
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
  // The sidebar's two parent edges, as data — chat_tree and chat_state's family.
  const chatTreeDeps: ChatTreeDeps = {
    getChat: (chatId) => store.getChat(chatId).catch(() => null),
    // Memoized: chat_state is polled, and every call needs the project's listing.
    listChats: memoizedChatLister((projectId) => store.listChats(projectId)),
    getPrRecord: (key) => store.getPrRecord(key),
  };
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
      send: (chatId, text, { peer, channel }) => broker.sendMessage(chatId, text, { peer, channel }),
      // Raw usage, not a pre-rounded percentage: the messenger derives one
      // itself for the harnesses that report only totals.
      getContextUsage: (chatId) => broker.getContextUsage(chatId),
      // `awaiting-input` is the status a chat sits in while a permission card or
      // a question is open in front of the human — the one thing a project
      // manager most needs to know it cannot fix by waiting.
      isBlockedOnHuman: (chatId) => broker.getStatus(chatId) === "awaiting-input",
      getPrRecord: (key) => store.getPrRecord(key),
      family: (chat) => chatFamily(chat, chatTreeDeps),
    });
  broker.messenger = chatMessenger;
  // The external MCP mount: a category server per integration request, built
  // from a context with no self chat. Wired here rather than in the bridge's
  // constructor because it closes over services constructed after it.
  // Late-bound through `services` like `broker.spawnChat`: `createChat` needs
  // the whole container, which is assembled below.
  const channelChats = new ChannelChatService({
    getProject: (id) => store.getProject(id).catch(() => null),
    createChat: (input) => createChat(services, input),
    ensureSession: (chatId) => ensureSession(services, chatId),
    permissionModeOf: (modeId) => broker.permissionModeOf(modeId),
    send: (input) => chatMessenger.send(input),
    getChat: (id) => store.getChat(id).catch(() => null),
    interrupt: (chatId) => broker.interrupt(chatId),
    // The sidebar reap's three steps (`POST /api/chats/processes/kill`):
    // `broker.stop` owns only the provider's subtree — shells are separate
    // roots, and Codex launches MCPs from its shared app-server.
    release: async (chatId) => {
      await broker.stop(chatId).catch(() => {});
      terminals.killChat(chatId);
      await reapChatResidual({ chatProcesses, processes }, chatId).catch(() => {});
      chatProcesses.invalidate();
    },
    archive: async (chatId, archived = true) => {
      const saved = await store.patchChat(chatId, { archived });
      if (saved) bus.publish({ type: "chat-update", chat: saved });
    },
  });
  const chatSummaries = new ChatSummaryService({ store, harnesses });
  managerMcp.setIntegrationContext((identity) =>
    createIntegrationContext(
      {
        bus,
        store,
        broker,
        inspect,
        messenger: chatMessenger,
        memory,
        memoryHistory,
        issues,
        authored,
        channelChats,
        summaries: chatSummaries,
        getProject: (id) => store.getProject(id).catch(() => null),
        listProjects: () => store.listProjects(),
        listPersonas: (projectId) => personasFor(store, authored, projectId),
        events: eventFeed,
        chatTree: (chatId, depth) => chatTree(chatId, chatTreeDeps, depth),
        attention,
        questions: broker,
      },
      identity,
    ),
  );
  // The plugin host. Plugins live in the CONFIG root (shared by both instances,
  // never replaced by an upgrade); their kv rows live in this instance's state
  // database. Everything a plugin can reach goes through the services above —
  // the messenger for sends (never the broker), the queue for attention — so
  // it is constructed after all of them.
  // The OAuth client flow for plugins. Built before the plugin service because
  // the context hands it out as `ctx.oauth`; it looks manifests up through the
  // plugin service lazily (per request), which is why the closure below may
  // name a `const` that is assigned a few lines further down.
  const pluginOAuth: PluginOAuthService =
    overrides.pluginOAuth ??
    new PluginOAuthService({
      store,
      secrets,
      resolve: (id) => plugins.oauthView(id),
      canonicalUrl: async () => (await store.getSettings()).auth?.canonicalUrl,
    });
  const plugins: PluginService =
    overrides.plugins ??
    new PluginService({
      configDir: config.configDir ?? config.dataDir,
      // Codex and goose. Resolved from this module, so a test container that
      // builds its own `PluginService` override never loads them by accident.
      shippedRoot: findShippedPluginsRoot(),
      store,
      context: {
        bus,
        secrets,
        inspect,
        memory,
        attention,
        messenger: chatMessenger,
        broker,
        pluginOAuth,
        // Announced on the bus either way: a chat's provider-unavailable state
        // is derived from the registered list, so an open tab re-reads it here
        // and a chat on a plugin that was just re-enabled recovers without a
        // reload (#426).
        providers: {
          register: (harness, descriptor) => {
            harnesses.register(harness, descriptor);
            bus.publish({ type: "providers-changed" });
            // Learn its login in the background, before anyone sends: a probe
            // only for a provider that is registered, so a disabled plugin's
            // CLI is never spawned (#422).
            void logins.refresh(harness.kind).catch(() => {});
          },
          unregister: async (kind) => {
            await harnesses.unregister(kind);
            logins.forget(kind);
            bus.publish({ type: "providers-changed" });
          },
        },
        terminals: terminalBackends,
      },
      // Plugin processes run through the SAME runner as sub-apps — port
      // allocation, log ring, env quarantine, `stopAll()` at shutdown.
      runner,
      cleanups: pluginCleanups,
      // What `reconcile` is told: every chat, with the backend its terminals
      // go to by default, so a terminal plugin can tell its own chats apart.
      liveChats: async () =>
        (await store.listChats()).map((c) => {
          const backend = terminalBackends.defaultBackendOf(c);
          return {
            id: c.id,
            projectId: c.projectId,
            ...(c.archived ? { archived: true } : {}),
            ...(backend ? { terminalBackend: backend } : {}),
          };
        }),
    });
  // The `plugin` scope and the plugin mode/MCP homes. Wired after the fact
  // because both consumers were constructed before the host existed; until
  // this line they behave as if no plugin were installed, and `GET /api/modes`
  // and the broker read these live so a toggle in Settings takes effect on the
  // next session without a restart.
  authored.setPluginSource(plugins);
  broker.plugins = plugins;
  const pluginInspector: PluginInspector =
    overrides.pluginInspector ??
    new PluginInspector({
      configDir: config.configDir ?? config.dataDir,
      hostInfo: (id) => plugins.get(id),
      noteInstalled: (id) => plugins.noteInstalled(id),
      recordSource: (id, source) => plugins.recordSource(id, source),
    });
  const pluginUpdates: PluginUpdateWatcher =
    overrides.pluginUpdates ??
    new PluginUpdateWatcher({
      inspector: pluginInspector,
      list: () => plugins.list(),
      notice: (level, text) => bus.publish({ type: "notice", level, text }),
      intervalHours: pluginUpdateHours(),
    });
  // "The chat you spawned is done" — armed by `broker.spawnChat` below, delivered
  // over the messenger above. Constructed here because it needs both, and
  // disposed in `dispose()` so a pending notice is not a reason the process
  // stays up.
  const chatCompletionNotices =
    overrides.chatCompletionNotices ??
    new ChatCompletionNotices({
      bus,
      // Re-read after the settle window, so a child that only LOOKED finished
      // — `onTurnEnd` publishes `idle` before flushing whatever was queued
      // during the turn — is not announced as done mid-flight.
      getStatus: (chatId) => broker.getStatus(chatId),
      // The other half of that re-read, and the half that is a FACT rather than
      // elapsed time: a queued message mid-flush, or a parked peer message, is
      // a turn about to open under an `idle` status.
      hasPendingWork: (chatId) =>
        broker.hasPendingWork(chatId) || chatMessenger.hasPending(chatId),
      getTitle: (chatId) =>
        store
          .getChat(chatId)
          .then((c) => c?.title)
          .catch(() => undefined),
      send: ({ from, to, message }) =>
        // `queue`, never `interrupt`: a parent mid-turn on something else must
        // not have that turn derailed by news it did not ask for right now.
        chatMessenger.send({ from, to, message, delivery: "queue" }),
    });
  // The nesting walk needs BOTH parent edges, and the reviewer one is a PR
  // record rather than a chat field — so it is assigned here, where the store
  // is, for the same reason `spawnChat` below is.
  broker.chatNestingDepth = (chatId) =>
    chatNestingDepth(chatId, {
      getChat: (id) => store.getChat(id).catch(() => null),
      prAuthorChatId: (key) =>
        store
          .getPrRecord(key)
          .then((row) => row?.chatId ?? null)
          .catch(() => null),
    });
  broker.spawnChat = async ({ request, project, parentChatId }) => {
    // A spawned chat is an extension of the chat that asked for it, so the
    // parent's posture is the least-surprising default: `resolveChatPosture`
    // puts the parent layer between the request and the project, for provider,
    // account, model, effort and mode alike. (Effort and mode used to be left
    // out and fell straight to the app defaults, so a child of a `plan`/`max`
    // parent came up `auto`/`medium`.) Project/app defaults are for chats
    // started from the UI, not for a child silently changing runtimes
    // underneath its parent.
    const parent = await store.getChat(parentChatId).catch(() => null);
    // A parent that names no provider hands none down; the child then needs
    // the request, the project or the app to name one, and `createChat` says
    // so clearly when none does.
    const parentProvider = parent?.harness;
    const settings = await store.getSettings().catch(() => null);
    const named = findSubscription(settings, request.subscription);
    if (request.subscription && !named) {
      throw new Error(`No subscription "${request.subscription}".`);
    }
    if (named && request.provider && named.provider !== request.provider) {
      throw new Error(
        `Subscription "${named.id}" is a ${named.provider} account, not ${request.provider}.`,
      );
    }
    const chat = await createChat(services, {
      projectId: project.id,
      title: request.title,
      modeId: request.modeId,
      harness: request.provider,
      subscriptionId: named?.id,
      agentId: request.agentId,
      personaId: request.personaId,
      effort: request.effort,
      model: request.model,
      // The parent's account is RESOLVED rather than copied, so a legacy parent
      // with no pin hands down the account it actually runs under. The resolver
      // drops it — and the parent's model — when the child lands on another
      // provider, since both belong to one provider's catalogue.
      parent:
        parent && parentProvider
          ? {
              harness: parentProvider,
              subscriptionId: pinnedIdOf(
                chatSubscription(settings, {
                  harness: parentProvider,
                  subscriptionId: parent.subscriptionId,
                }),
              ),
              modeId: parent.modeId,
              effort: parent.effort,
              model: parent.model,
            }
          : undefined,
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
    // ARMED BEFORE THE BRIEF GOES OUT, and that order is load-bearing: the
    // notice watches for the child's turn ending, and a short turn would
    // otherwise finish into a bus nobody is subscribed to. Detached spawns get
    // one too — `detached` is about where the row sits in the sidebar, not about
    // whether the caller wanted to hear back.
    if (request.notifyWhenComplete) {
      chatCompletionNotices.arm({
        chatId: chat.id,
        parentChatId,
        // Only the FALLBACK title: the notice re-reads the live one when it
        // fires, because at this instant an auto-titled chat is still called
        // whatever `createChat` named it.
        title: chat.title,
      });
    }
    // Stamped `peer`, exactly like a `chat_send`, because that is what it is: an
    // AGENT wrote this prompt via `spawn_chat` and the human only approved the
    // spawn. Unstamped it landed as the new chat's opening speech bubble — the
    // most prominent row in the transcript, attributed to a person who never
    // typed a word of it — and the model was told nothing either, so a spawned
    // chat would answer its briefing as though the human were sitting there
    // waiting. The `peer` stamp fixes both halves: the row renders as a card
    // naming the sender, and `peerReminder` tells the model who it heard from.
    //
    // Denormalised title, per PeerSenderSchema: the parent may be renamed or
    // deleted long before anyone reads this row, and a transcript can't be
    // rewritten. Best-effort — a missing parent must not fail the spawn.
    try {
      await broker.sendMessage(chat.id, request.prompt, {
        peer: { chatId: parentChatId, title: parent?.title, projectId: parent?.projectId },
      });
    } catch (err) {
      // The brief never landed, so this chat was never given the work the notice
      // would be reporting on — and the tool is about to tell the caller the
      // spawn failed. Left armed, the notice sits for its whole 24 hours and
      // then reports an unrelated turn somebody later starts in this blank chat
      // as the delegated work completing.
      chatCompletionNotices.disarm(chat.id);
      throw err;
    }
    return {
      chatId: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName: project.name,
      // `createChat` refuses a chat with no provider, so this is always set.
      provider: chat.harness!,
      model: chat.model,
    };
  };

  const secretRefresher: SecretRefresher = new SecretRefresher({ projectConfig, broker, runner });
  // A secret saved by the OTHER instance (they share config/) refreshes this
  // one's consumers too; our own saves are refreshed by whoever made them.
  secrets.onExternalChange((keys) => void secretRefresher.refresh(keys).catch(() => {}));

  let offCheckpoint: (() => void) | undefined;
  let offTitle: (() => void) | undefined;
  let offReap: (() => void) | undefined;
  let offMemoryMigrate: (() => void) | undefined;
  /** Set by `dispose()`. Read between every await in `warm()` — see both. */
  let disposed = false;
  /** The in-flight `warm()`, so `dispose()` can wait for it to unwind. */
  let warming: Promise<void> | undefined;

  // Arms one best-effort background service. A throw in any ONE of them must
  // not abort boot and silently skip the wiring AFTER it — that ordering once
  // risked leaving AI titles + auto-checkpoints un-wired with no error at all.
  // Isolate + LOG each failure so it's visible, never a silent cascade.
  // Out here rather than inside `start()` because `warm()` needs it too.
  const safeStart = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error(`[Dispatch] ${label}.start() failed (continuing):`, err);
    }
  };

  /**
   * The body of `services.warm()`. Out here, not in the object literal, so
   * `warm()` can memoise it into `warming` and `dispose()` can await that.
   */
  const warmOnce = async (): Promise<void> => {
    // Agent-created worktree detection goes first: its per-project baseline is
    // what stops worktrees that already existed being reported as newly
    // created, and a resumed turn is the first thing that can complete and ask.
    // Nothing can have finished a turn in the milliseconds since `listen`, and
    // RESUME_START_DELAY_MS holds the resumes off on top of that — but ordering
    // it ahead of `resume.restore()` keeps that true without relying on either.
    // Best-effort, like everything here — a git/seed failure just means no
    // detection this boot.
    await worktreeDetector.start().catch(() => {});
    if (disposed) return;

    // Re-arm auto-resumes persisted before the last shutdown, so a restart
    // never strands a chat waiting on a limit that has since lifted.
    await resume.restore().catch(() => {});
    if (disposed) return;

    // Adopt the persisted terminal roster (as archived — this process owns no
    // shells yet) and start the retention sweep. `unref` so a timer can never
    // be the reason the process won't exit.
    // Before anything can open a shell: which chats are pinned to a terminal
    // backend, so one pinned to a plugin that has not activated yet still
    // resolves (and waits for it) instead of quietly coming up local.
    try {
      terminalBackends.seed(await store.listChats());
    } catch {
      /* an unreadable chat list costs the warning, never the boot */
    }
    try {
      await terminals.reconcile();
      await terminals.sweep();
    } catch {
      /* an unreadable terminals.json must never block boot either */
    }
    if (disposed) return;
    terminalSweep = setInterval(() => {
      void terminals.sweep().catch(() => {});
    }, TERMINAL_SWEEP_MS);
    terminalSweep.unref?.();

    // Seed the PR catalog from every chat's `Chat.prs` BEFORE the sweep runs,
    // so PRs opened before this catalog existed appear with nobody doing
    // anything. No GitHub calls — the rows come from the pointers a chat
    // already holds, and the first sweep fills in live state.
    await prRegistry.backfill().catch((err: unknown) => {
      console.error("[Dispatch] PR catalog backfill failed (continuing):", err);
    });
    if (disposed) return;
    // Notices review rounds on PRs chats own — the half of the loop that
    // doesn't require an agent to keep asking — and keeps the catalog current.
    safeStart("prReviewWatcher", () => prReviewWatcher.start());
    safeStart("issueWatcher", () => issueWatcher.start());

    // The runner reconcile BEFORE plugin activation. A plugin's `autostart`
    // asks the runner whether its process is already running, and after an
    // unclean exit (a hard kill — Windows delivers no SIGTERM) the persisted
    // row still says `running` with a dead pid until this pass rewrites it.
    // Activation racing ahead of it would find that row, start nothing, and
    // the reconcile would then mark the row stopped — a plugin process that
    // never comes back after a crash. The host also checks liveness itself
    // (`PluginProcessHost.running`), so this ordering is belt and braces for
    // the case that matters most, not the only guard.
    try {
      await runner.reconcile();
    } catch {
      /* a missing runners.json / dead pid probe must never block boot */
    }
    if (disposed) return;

    // Plugins activate HERE, after listen, and not in `start()`: each
    // `activate` is third-party code on a 30 s budget, and awaiting it before
    // the port opened would hold the health check shut long enough for
    // `install.mjs` to roll a good update back — the failure that split
    // `start()` from `warm()`. Their route prefixes answer 503 until then.
    //
    // NOT awaited: the plugins run serially, so one hung `activate` is a
    // minute, and nothing in boot should wait a minute for it.
    // `plugins.dispose()` joins whatever is still in flight.
    void plugins.activateAll().catch((err: unknown) => {
      console.error("[Dispatch] plugin activation failed (continuing):", err);
    });
  };

  const services: Services = {
    config,
    store,
    bus,
    harnesses,
    logins,
    managerMcp,
    broker,
    secrets,
    issues,
    secretRefresher,
    terminals,
    terminalBackends,
    memory,
    authored,
    houseRules,
    claudeMemory,
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
    retention,
    git,
    growth,
    commitMessage,
    runner,
    processes,
    chatProcesses,
    procTableCache,
    resources,
    github,
    ci,
    notifier,
    webhooks,
    eventFeed,
    push,
    attention,
    home,
    release,
    resume,
    failover,
    chatMessenger,
    channelChats,
    chatSummaries,
    chatCompletionNotices,
    plugins,
    pluginInspector,
    pluginUpdates,
    pluginOAuth,
    fileIndex,
    fsExplorer,
    metrics,
    metricsBackfill,
    tokens,
    limits,
    limitSampler,
    trunkSync,
    prReviewWatcher,
    issueWatcher,
    prRegistry,
    restartResume,
    pause,

    async start(): Promise<void> {
      // This runs before clients hydrate. Graceful shutdowns have already
      // persisted `done`; only a killed/crashed process leaves a live status.
      await recoverInterruptedChatStatuses(store).catch((err) => {
        console.error("[Dispatch] chat status recovery failed (continuing):", err);
      });

      // Before anything can send: `restartResume.restore()` (start.ts) and the
      // usage-limit resumes would otherwise start turns the pause was holding.
      await pause.restore();

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
          // Same arrangement for the Attention Queue filter: the push service
          // holds it (its bus handler is synchronous), `PUT /api/settings` hands
          // it over on every save, and this is where it starts out.
          push.setQueueFilter(s.attentionQueue);
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
      // Before project config: its first load expands `${secret:NAME}`.
      await secrets.start({ watch: true });
      await projectConfig.start().catch(() => {});

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
            // The homepage warm-up below starts while this is still importing,
            // so whatever it cached was taken mid-import — on a fresh install,
            // of an empty ledger. The page fetches once on arrival and never
            // polls, so that snapshot is what the first visitor would see and
            // keep seeing for the whole TTL. Throw it away now that the real
            // history is in.
            home.invalidate();
          }
        },
        (err: unknown) => console.error("[Dispatch] metrics backfill failed:", err),
      );
      // Same deal for token history, under its own watermark. Not awaited.
      void tokenBackfill.run().then(
        (r) => {
          if (r.ran) {
            console.log(
              `[Dispatch] metrics: imported ${r.rows} token row(s) from ${r.chats} chat(s).`,
            );
          }
          // After the import, so rows it just wrote are already complete and
          // only older live rows are left to fill.
          // Its own catch: the rejection handler below only covers `run()`,
          // not a promise returned from this one, and an uncaught failure here
          // would be logged as a crash rather than as a failed backfill.
          return tokenBackfill
            .fillDurations()
            .then((n) => {
              if (n) console.log(`[Dispatch] metrics: filled ${n} token row duration(s).`);
            })
            .catch((err: unknown) =>
              console.error("[Dispatch] token duration backfill failed:", err),
            );
        },
        (err: unknown) => console.error("[Dispatch] token backfill failed:", err),
      );

      safeStart("attention", () => attention.start());
      // Warms the default window so the first visit to the homepage doesn't
      // pay for the cold read. Fire-and-forget inside; boot never waits.
      safeStart("home", () => home.start());
      safeStart("memoryCommitter", () => memoryCommitter.start());
      safeStart("notifier", () => notifier.start());
      // Resumes deliveries a shutdown left pending. Async, but awaited inside
      // safeStart's try so a corrupt row is logged rather than fatal.
      safeStart("webhooks", () => void webhooks.start().catch((err: unknown) =>
        console.error("[Dispatch] webhooks failed to start:", err)));
      // Seeds each tracked PR's last state first, so a boot never announces
      // every open PR as newly opened.
      safeStart("eventFeed", () => void eventFeed.start().catch((err: unknown) =>
        console.error("[Dispatch] event feed failed to start:", err)));
      safeStart("push", () => push.start());
      // Ahead of the limit sampler, so its first pass already sees the
      // built-in providers' accounts.
      //
      // Discovery — a readdir and a YAML parse per plugin, so it is bounded
      // and `GET /api/plugins` can answer from the first request. No
      // INSTALLED plugin's code runs until `warm()`.
      await plugins.load().catch((err: unknown) => {
        console.error("[Dispatch] plugin discovery failed (continuing):", err);
      });
      // The built-in providers (Claude, Codex, goose) register HERE, before listen —
      // see the header of plugins/service.ts. A failure is the plugin's row,
      // not the boot's: chats on it show "provider unavailable", the pane says why.
      await plugins.activateShipped().catch((err: unknown) => {
        console.error("[Dispatch] built-in plugin activation failed (continuing):", err);
      });
      // Every account's limit windows, on one schedule — which is also what
      // keeps the header meter's usage snapshots fresh (a missing token /
      // offline just yields an "unavailable" snapshot the meter hides on).
      safeStart("limitSampler", () => limitSampler.start());
      // Release polling. A no-op unless this payload came from a release, and
      // its first check is deferred so an unreachable GitHub delays no boot.
      // Hydrate the channel FIRST — a check that ran before the subscription
      // loaded would ask the stable endpoint on behalf of an unstable install.
      await release.hydrate().catch(() => {});
      safeStart("release", () => release.start());
      // Same shape as release polling: deferred first pass, unref'd interval.
      safeStart("pluginUpdates", () => pluginUpdates.start());
      // Backoff retries of failed plugin cleanups. Each plugin's own rows are
      // also retried right after it activates (see `PluginService.reconcileOne`).
      safeStart("pluginCleanups", () => pluginCleanups.start());
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

      // NOTE: everything whose cost scales with the SIZE of this install —
      // `resume.restore()`, the PR catalog backfill, worktree detection, the
      // runner and terminal reconciles — has moved to `warm()`, which runs
      // after `app.listen()`. See the comment on `warm` for the rollback that
      // forced the split.

      // Data retention: checkpoints on removed worktrees, settled reviewer
      // chats, old tool-output images. Hourly, and NOT at boot like the terminal
      // sweep in `warm()` — its first pass on an install with a backlog deletes
      // thousands of refs and reads transcripts, which has no business racing
      // startup. See RETENTION_FIRST_SWEEP_MS. Only the timer is armed here, so
      // this stays on the bounded side of the split.
      retention.start();

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

    /**
     * The half of boot whose cost scales with the install, run AFTER the port
     * is answering.
     *
     * This exists because of a specific failure, five times on one machine:
     * `tools/app/launch.py` gates a start on a port probe with a 60s clock
     * (`START_TIMEOUT_S`), and `tools/install.mjs` treats that expiry as a bad
     * payload and rolls the update back. `buildApp()` awaits `start()` before
     * `start.ts` calls `app.listen()`, so every await in here used to hold the
     * port shut — and none of these is bounded by anything but how much the
     * install contains: the PR backfill walks every chat (1618 of them, 4GB of
     * transcripts, on the install this was diagnosed on), `worktreeDetector`
     * spawns git per project, `runner.reconcile()` awaits a
     * `docker compose down` per persisted docker runner (routinely 5-30s).
     * A perfectly healthy build therefore answered at >60s, got killed, and was
     * rolled back — reported as "the server printed nothing", because the first
     * `console.log` is after `listen` too.
     *
     * `restartResume.restore()` was moved out for exactly this reason already
     * (see RESUME_START_DELAY_MS); this generalises it. The rule for deciding
     * where something belongs: `start()` is for work that is BOUNDED and that
     * the very first request would be wrong without — chat status recovery, the
     * session cap, authored config, bus subscriptions. Everything else warms.
     *
     * The cost is a brief window after boot where the terminal roster and the PR
     * catalog read empty and fill in moments later. That is strictly better than
     * a closed port, which the updater cannot tell apart from a hung build.
     */
    warm(): Promise<void> {
      // Memoised, so a second caller joins the first pass rather than running a
      // second one — and so `dispose()` has a handle to wait on no matter who
      // called it.
      //
      // The `catch` is the contract, not politeness: `start.ts` calls this as
      // `void services.warm()`, and a rejection on a floating promise is an
      // unhandled rejection — which is fatal to the process, taking every live
      // session with it (see crash-log.ts). Every step below already handles its
      // own failure; this covers whatever none of them anticipated.
      warming ??= warmOnce().catch((err: unknown) => {
        console.error("[Dispatch] warm boot pass failed (server stays up):", err);
      });
      return warming;
    },

    async dispose(): Promise<void> {
      // Before awaiting anything: every `if (disposed) return` in `warm()` is
      // reading this, and a warm still in flight would otherwise arm services
      // (and spawn git) on the far side of the teardown that was meant to stop
      // them. Then wait for it to actually unwind, so no subprocess outlives
      // the store it was spawned against — same reasoning as the `drain()`
      // calls below.
      disposed = true;
      await warming?.catch(() => {});
      secrets.stop();
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
      // Same shape: disarm, then let an in-flight pass finish deleting rather
      // than closing the store under a half-retired checkpoint batch.
      retention.stop();
      await retention.drain().catch(() => {});
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
      // Clears every retry timer; pending rows are resumed by the next boot.
      webhooks.dispose();
      eventFeed.dispose();
      push.stop();
      attention.stop();
      // Unsubscribe first, then let an in-flight sweep land rather than yanking
      // the store out from under it.
      prReviewWatcher.dispose();
      await prReviewWatcher.drain().catch(() => {});
      issueWatcher.dispose();
      await issueWatcher.drain().catch(() => {});
      limitSampler.stop();
      release.stop();
      // An auto-update mid-copy finishes rather than leaving a half-renamed slot.
      pluginUpdates.stop();
      await pluginUpdates.drain().catch(() => {});
      // Rows not yet retried stay in state.db; the next boot picks them up.
      pluginCleanups.stop();
      await pluginCleanups.drain().catch(() => {});
      // Disarm first so nothing new fires, then let an in-flight resume land
      // before the broker goes away under it.
      resume.dispose();
      await resume.drain().catch(() => {});
      // Releases every chat blocked in `chat_ask`. Before the broker goes away,
      // so a waiting session is told the answer is not coming rather than
      // hanging on a promise nothing is left to resolve.
      // Plugins go BEFORE the messenger and the broker: a `deactivate` may
      // still want to send a last message or read a chat, and their bus
      // listeners should be gone before the broker's teardown floods the bus.
      await plugins.dispose().catch(() => {});
      chatMessenger.dispose();
      chatCompletionNotices.dispose();
      await runner.stopAll().catch(() => {});
      // ORDER IS LOAD-BEARING: this must read the broker's live sessions BEFORE
      // `dispose()` tears them down. Teardown overwrites every status with
      // `done` and empties every outbox, so one line later there is nothing left
      // to record and auto-resume is silently a no-op.
      //
      // Reaching `dispose()` at all is also the entire proof that the stop was
      // deliberate — a crash runs none of this and therefore, correctly, resumes
      // nothing. Disarm our own boot timer first: a shutdown seconds after boot
      // must not fire a resume into a server that is going away.
      restartResume.dispose();
      await restartResume.drain().catch(() => {});
      await restartResume.capture(broker.interruptionSnapshot()).catch(() => {});
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
