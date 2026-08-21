/**
 * WorktreeDetector — attributes AGENT-created git worktrees to the chat that
 * created them.
 *
 * Worktrees in this system are made BY THE AGENT: inside a turn it runs
 * `pnpm worktree <branch>` / `git worktree add …` via Bash (cwd = the project's
 * repoPath) or calls the harness's own `EnterWorktree` tool, NOT by the user
 * through the manager, and a single chat turn may
 * create SEVERAL. Nothing on the wire announces them, so the manager has to
 * DISCOVER them: we list the project's live `git worktree list --porcelain`,
 * diff it against the set we've already accounted for, and attribute any
 * newcomer to the chat that CREATED it — through the same `attachToChat` link
 * path `create()` uses (saveChat + chat-update + worktree-update). Worktrees the
 * agent has torn down are detached.
 *
 * THE REGISTRY OUTRANKS ALL OF THIS. `worktrees.json` records who owns a tree at
 * the moment it is created — by the panel, or by `mcp__manager__worktree`, which
 * is now the only path an agent is allowed to take (`git worktree add` in a
 * shell is refused; see shell-guard.ts). For those trees there is nothing to
 * infer, and a recorded `chatId` is treated as fact. What remains below is the
 * RECOVERY path, for the two cases the registry cannot cover: the harness's own
 * `EnterWorktree`, which Dispatch does not mediate, and a tree that predates the
 * registry or was cut outside Dispatch entirely.
 *
 * ATTRIBUTION. Detection is project-wide, not "whatever chat's turn just
 * completed". Ownership is reconstructed from each chat's OWN transcript: we scan
 * its persisted `tool_use` rows (+ the live `chat-message` bus) for a
 * worktree-CREATE command (`git worktree add -b <branch>` / `pnpm worktree
 * <branch>`) and record `chatId → branch → earliest-ts`, yielding a global
 * `branch → owning-chat` map (earliest creator wins a tie), then an
 * `EnterWorktree` claim on the path, then an existing unambiguous
 * `chat.worktrees[]` link (how a tree that predates the registry keeps its
 * owner). Whatever is recovered is WRITTEN BACK to the registry, so each of
 * these derivations happens once rather than on every pass forever.
 *
 * The two weakest tiers are GONE. "A chat whose history mentioned this path" and
 * "a chat with a PR on this branch" were guesses that read as facts: a chat that
 * merely `cd`-ed into a colleague's tree, or opened a PR on a branch it didn't
 * cut, took ownership of it. With creation now recorded, a tree with no evidence
 * is LEFT UNATTACHED — and the Workspace view shows it as unattributed, which is
 * a state someone can see and fix, rather than a wrong owner nobody questions.
 *
 * ENTERWORKTREE. The harness's `EnterWorktree` tool creates the tree ITSELF —
 * there is no shell command to parse, so command-based detection saw NOTHING and
 * the worktree stayed unattached until some later signal landed. In practice that
 * was the PR tier, which is exactly why an agent's worktree only showed up in the
 * sidebar once it opened one — and exactly why that tier had to go rather than
 * stay as a crutch. We claim by PATH from the tool call — its `path` input
 * (entering an existing tree), its `name` input
 * (→ `<repo>/.claude/worktrees/<name>`), and the path its RESULT reports
 * ("Created worktree at <path> on branch <branch>"). Earliest claimant wins, and
 * a real create-command still outranks a claim, so a chat that merely switched
 * into another agent's tree cannot steal it from its creator.
 *
 * SELF-HEALING REWRITE (bug fix). Every reconcile (startup heal + each poll +
 * turn-complete) REWRITES each chat's `worktrees[]` to EXACTLY the live worktrees
 * it owns — removing a stale/wrong attribution and adding a correctly-owned one —
 * then persists the corrected `chat.json` and emits `chat-update` /
 * `worktree-update`. Because ownership is derived from history (not "newness"),
 * a bad attribution PERSISTED by an older build is re-healed on the next start,
 * not frozen in place. PRs correlate to a chat by the same branch → chat map
 * (the per-chat PRs view scopes to a chat's worktree branches).
 *
 * LIVE SYNC (bug fix). Turn-complete is not enough: in Bypass mode a whole
 * session is one long running turn, so a worktree created mid-turn wouldn't show
 * until the turn ended. While ANY chat is active we also POLL every
 * `pollIntervalMs` (~4s), running a cheap project-wide pass (one
 * `git worktree list --porcelain` per active project per tick, deduped) so new
 * worktrees sync in near-real-time. Polling stops once no chat is active.
 *
 * Wiring (see container.ts): we subscribe to `chat-status` + `chat-message`.
 *   - `running` SEEDS the chat's project baseline at turn START — before the
 *     agent can create anything — so only worktrees that appear DURING the turn
 *     read as new, and starts the poll loop.
 *   - `chat-message` tool_use rows record the branch(es) a chat created.
 *   - `idle` (turn complete) / `done` (session ended) / `error` trigger a
 *     detection pass and, when no chat is left active, stop the poll loop.
 *   - `refresh(chatId)` / `refreshProject(projectId)` are manual entry points.
 * All work funnels through one promise chain so a seed always lands before the
 * detection that depends on it (bus listeners are fire-and-forget, so we can't
 * await inside the handler).
 *
 * We deliberately DON'T touch a session's cwd — it stays at repoPath so the
 * agent can create/switch worktrees itself; the detector only observes and
 * attributes.
 */
import { isAbsolute, resolve, sep } from "node:path";
import type {
  Chat,
  ChatMessage,
  ChatStatus,
  Project,
  WorktreeInfo,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import type { WorktreeService } from "./worktree.js";

export interface WorktreeDetectorDeps {
  store: Store;
  bus: EventBus;
  worktrees: WorktreeService;
  /** Poll cadence while a chat is active (ms). Default 4000. */
  pollIntervalMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
}

/** Outcome of one detection pass for a chat. */
export interface WorktreeDetectionResult {
  chatId: string;
  /** Worktree paths newly attached to this chat this pass. */
  attached: string[];
  /** Worktree paths detached from this chat this pass (gone from disk). */
  removed: string[];
}

/** Chat statuses that mean the session is live (creating work). */
function isActiveStatus(status: ChatStatus): boolean {
  return (
    status === "running" ||
    status === "waiting" ||
    status === "queued" ||
    status === "awaiting-input"
  );
}

/**
 * Canonical key for path-set membership. `resolve()` normalizes separators +
 * `.`/`..`; Windows' filesystem is case-insensitive so we case-fold there. This
 * makes `git`'s spelling (often forward-slashed) and a stored `join()` spelling
 * (native) compare equal so a worktree is never double-attributed.
 */
function canonPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** Fold `key → ts` into a nested map, keeping the EARLIEST ts for the key. */
function earliest(
  outer: Map<string, Map<string, number>>,
  id: string,
  key: string,
  ts: number,
): void {
  let inner = outer.get(id);
  if (!inner) {
    inner = new Map<string, number>();
    outer.set(id, inner);
  }
  const prev = inner.get(key);
  if (prev === undefined || ts < prev) inner.set(key, ts);
}

/**
 * Pull the worktree path out of an `EnterWorktree` tool result, whose text reads
 * "Created worktree at <path> on branch <branch>. …". The path may contain
 * spaces, so it's matched non-greedily up to the " on branch " separator; the
 * second form covers a result that names a path but no branch.
 */
export function parseEnterWorktreeResult(
  content: unknown,
): { path: string; branch?: string } | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === "string"
                ? c
                : typeof (c as { text?: unknown })?.text === "string"
                  ? (c as { text: string }).text
                  : "",
            )
            .join("\n")
        : "";
  if (!text) return undefined;
  // The branch runs to the sentence terminator, NOT to the first dot — a dot is
  // legal in a branch name (`release/v1.2.3`), so only a `.` that ends the
  // sentence (followed by space or end) closes it.
  const withBranch = /worktree at (.+?) on branch (\S+?)(?=\.(?:\s|$)|\s|$)/.exec(
    text,
  );
  if (withBranch) return { path: withBranch[1], branch: withBranch[2] };
  const bare = /worktree at (.+?)(?:[.]\s|[.]?$|\n)/.exec(text);
  return bare ? { path: bare[1].trim() } : undefined;
}

export class WorktreeDetector {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly worktrees: WorktreeService;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  /** Canonical paths already accounted for (baseline seeds + prior attaches). */
  private readonly known = new Set<string>();
  /** Project ids whose baseline has been captured. */
  private readonly seeded = new Set<string>();
  /** chatId → (branch → earliest epoch ms it CREATED it), from history + live tool_use. */
  private readonly chatBranches = new Map<string, Map<string, number>>();
  /** chatId → (canonical worktree path → earliest ts it CLAIMED via `EnterWorktree`). */
  private readonly chatWorktreePaths = new Map<string, Map<string, number>>();
  /** chatId → (`EnterWorktree` name → earliest ts), resolved against repoPath at reconcile. */
  private readonly chatWorktreeNames = new Map<string, Map<string, number>>();
  /**
   * toolUseId → chat that issued an `EnterWorktree`, so its RESULT (which names
   * the created path outright) can be attributed. The result row carries no
   * `name`, so the pending call is the only link back to the tool.
   */
  private readonly pendingEnters = new Map<string, string>();
  /** Chats whose persisted transcript has already been scanned for create-commands. */
  private readonly historyLoaded = new Set<string>();
  /** Chats whose session is currently active (drives polling). */
  private readonly activeChats = new Set<string>();

  /** Serializes all detector work so a seed lands before its detection. */
  private chain: Promise<void> = Promise.resolve();
  private offStatus?: () => void;
  private offMessage?: () => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollInFlight = false;

  constructor(deps: WorktreeDetectorDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.worktrees = deps.worktrees;
    this.pollIntervalMs = deps.pollIntervalMs ?? 4000;
    this.now = deps.now ?? (() => Date.now());
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Subscribe to status + message signals and seed every existing project. */
  async start(): Promise<void> {
    if (!this.offStatus) {
      this.offStatus = this.bus.on("chat-status", (evt) =>
        this.onStatus(evt.chatId, evt.status),
      );
    }
    if (!this.offMessage) {
      this.offMessage = this.bus.on("chat-message", (evt) =>
        this.onMessage(evt.chatId, evt.message),
      );
    }
    await this.enqueue(() => this.seedAll());
    // Heal persisted attribution on every boot: reconstruct ownership from each
    // chat's transcript and rewrite `chat.worktrees[]` to truth. This re-corrects
    // bad data an older build persisted (a server restart used to freeze it).
    await this.enqueue(() => this.healAll());
  }

  /** Unsubscribe from the bus + stop polling (teardown). */
  stop(): void {
    this.offStatus?.();
    this.offStatus = undefined;
    this.offMessage?.();
    this.offMessage = undefined;
    this.stopPolling();
  }

  /** Await any in-flight detector work (tests / graceful shutdown). */
  drain(): Promise<void> {
    return this.chain;
  }

  /** True while the live-sync poll loop is running (diagnostics / tests). */
  isPolling(): boolean {
    return this.pollTimer !== undefined;
  }

  /* --------------------------------------------------------- public API */

  /** Manually re-run detection for a chat (serialized behind pending work). */
  refresh(chatId: string): Promise<WorktreeDetectionResult> {
    return this.enqueue(() => this.detectForChat(chatId));
  }

  /**
   * Manually run a project-wide detection pass (client "Refresh" button /
   * GET /api/worktrees/refresh). Returns one result per affected chat.
   */
  refreshProject(projectId: string): Promise<WorktreeDetectionResult[]> {
    return this.enqueue(async () => {
      const project = await this.store.getProject(projectId).catch(() => null);
      if (!project) return [];
      const results = await this.reconcileProject(project);
      return [...results.values()];
    });
  }

  /**
   * Evict a path from the baseline because it left disk via a MANAGER-side removal
   * (WorktreeService.remove), which detaches the chat record OUTSIDE this detector.
   * The removal loop in `reconcileProject` only evicts paths still recorded on a
   * chat, so without this the path lingers in `known` and a worktree recreated at
   * the same path is skipped as "already accounted for" and never re-attributed.
   * Wired from the container via `WorktreeService.onWorktreeRemoved`.
   */
  forget(path: string): void {
    this.known.delete(canonPath(path));
  }

  /* ------------------------------------------------------- bus handlers */

  private onStatus(chatId: string, status: ChatStatus): void {
    if (isActiveStatus(status)) {
      this.activeChats.add(chatId);
      if (status === "running") {
        // Turn START: capture the project baseline BEFORE the agent can create a
        // worktree, so a worktree born this turn reads as new.
        void this.enqueue(() => this.ensureSeededForChat(chatId));
      }
      this.startPolling();
    } else {
      // idle (turn complete) | done (session ended) | error: discover what the
      // turn created/removed, then stop polling once nothing is active.
      this.activeChats.delete(chatId);
      void this.enqueue(() => this.detectForChat(chatId).then(() => undefined));
      if (this.activeChats.size === 0) this.stopPolling();
    }
  }

  private onMessage(chatId: string, message: ChatMessage): void {
    // `EnterWorktree` creates the tree with no shell command to parse — claim it
    // by path from the call, and again from its result (which reports the path
    // the harness actually chose). Both arrive mid-turn, so the ~4s poll picks
    // the worktree up live rather than at turn end.
    if (message.kind === "tool_use" && message.name === "EnterWorktree") {
      this.pendingEnters.set(message.toolUseId, chatId);
      this.recordEnterWorktree(chatId, message.input, message.ts ?? this.now());
      return;
    }
    if (message.kind === "tool_result") {
      const owner = this.pendingEnters.get(message.toolUseId);
      if (!owner) return;
      this.pendingEnters.delete(message.toolUseId);
      const hit = parseEnterWorktreeResult(message.content);
      if (hit) {
        this.recordWorktreePath(owner, hit.path, message.ts ?? this.now());
      }
      return;
    }
    if (message.kind !== "tool_use") return;
    const command = message.input?.command;
    if (typeof command !== "string" || !command) return;
    if (!looksLikeWorktreeCreate(command)) return;
    // Record the branch(es) this chat created + when, so detection can attribute
    // a matching worktree to it (not to whoever's turn happens to complete first).
    this.recordChatBranches(
      chatId,
      parseWorktreeBranches(command),
      message.ts ?? this.now(),
    );
  }

  /** Fold created-branch(es) into the chat's map, keeping the EARLIEST ts per branch. */
  private recordChatBranches(
    chatId: string,
    branches: string[],
    ts: number,
  ): void {
    if (branches.length === 0) return;
    let map = this.chatBranches.get(chatId);
    if (!map) {
      map = new Map<string, number>();
      this.chatBranches.set(chatId, map);
    }
    for (const branch of branches) {
      const prev = map.get(branch);
      if (prev === undefined || ts < prev) map.set(branch, ts);
    }
  }

  /** Fold one `EnterWorktree` INPUT into the chat's claims (path form or name form). */
  private recordEnterWorktree(
    chatId: string,
    input: Record<string, unknown> | undefined,
    ts: number,
  ): void {
    const path = typeof input?.path === "string" ? input.path.trim() : "";
    if (path) {
      this.recordWorktreePath(chatId, path, ts);
      return;
    }
    // The `name` form is only resolvable against the project's repoPath, which we
    // don't have on the bus — keep the raw name and resolve it in `buildBranchOwners`.
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (name) earliest(this.chatWorktreeNames, chatId, name, ts);
  }

  /**
   * Fold an absolute worktree path claim into the chat's claims (earliest wins).
   * A RELATIVE path is dropped rather than guessed at: `canonPath` resolves
   * against the server process's cwd, which is not the repo, so resolving one
   * would either match nothing or match the wrong tree. The client ignores a
   * relative `EnterWorktree.path` for the same reason (see `runLocation.ts`).
   */
  private recordWorktreePath(chatId: string, path: string, ts: number): void {
    if (!path || !isAbsolute(path)) return;
    earliest(this.chatWorktreePaths, chatId, canonPath(path), ts);
  }

  /* ------------------------------------------------------------ polling */

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.onPollTick(), this.pollIntervalMs);
    // Never keep the event loop alive just to poll (server/test shutdown clean).
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private onPollTick(): void {
    if (this.activeChats.size === 0) {
      this.stopPolling();
      return;
    }
    // Skip a tick if the previous pass is still running (slow git / big repo).
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    // `.finally()` used to clear the flag, but it returns a NEW promise that
    // rejects whenever the promise it chains off rejects. `enqueue`'s own promise
    // is safe (assigning `this.chain` attaches a rejection handler to it), but
    // that DERIVED promise had none — so a single failed pass became an unhandled
    // rejection, which Node treats as fatal. Settle both ways instead, so the
    // flag clears without ever leaving an unobserved rejection behind.
    void this.enqueue(() => this.pollActiveProjects()).then(
      () => {
        this.pollInFlight = false;
      },
      () => {
        this.pollInFlight = false;
      },
    );
  }

  /** One cheap detection pass per distinct project with an active chat. */
  private async pollActiveProjects(): Promise<void> {
    const projectIds = new Set<string>();
    for (const chatId of this.activeChats) {
      const chat = await this.store.getChat(chatId).catch(() => null);
      if (chat) projectIds.add(chat.projectId);
    }
    for (const projectId of projectIds) {
      const project = await this.store.getProject(projectId).catch(() => null);
      // Guarded per project, exactly like `healAll` — this was the ONE
      // `reconcileProject` call site with no catch. It is also the only loop in
      // the server whose iteration count is the number of DISTINCT projects with
      // an active chat, which is why the crash looked like "two projects at once"
      // rather than "one flaky project": with a second project in the set, one
      // project failing (a throwing bus subscriber on `chat-update`, a store
      // write losing a race) rejected the entire pass and killed the process,
      // and the still-healthy project's reconcile never ran either.
      if (project) await this.reconcileProject(project).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------- internals */

  /** Run `task` after all previously-queued work; never lets a rejection stick. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async seedAll(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) await this.seedProject(project);
  }

  private async ensureSeededForChat(chatId: string): Promise<void> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat || this.seeded.has(chat.projectId)) return;
    const project = await this.store.getProject(chat.projectId).catch(() => null);
    if (project) await this.seedProject(project);
  }

  /** Record the project's CURRENT worktrees as the baseline (idempotent). */
  private async seedProject(project: Project): Promise<void> {
    if (this.seeded.has(project.id)) return;
    // List FIRST, then commit the baseline — only mark the project seeded once we
    // actually captured its worktrees. A transient `list()` failure (repo mid-init,
    // index.lock, AV) must leave the project UNSEEDED so the next turn-start retries;
    // otherwise the baseline is just `repoPath`, every genuinely pre-existing worktree
    // reads as new, and gets misattributed to the next chat that goes idle.
    try {
      const infos = await this.worktrees.list(project);
      this.known.add(canonPath(project.repoPath));
      for (const info of infos) this.known.add(canonPath(info.path));
      this.seeded.add(project.id);
    } catch {
      /* repo not a git tree yet / transient — leave unseeded, retry next turn */
    }
  }

  /** Startup heal: reconcile every project so persisted attribution self-corrects. */
  private async healAll(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      await this.reconcileProject(project).catch(() => undefined);
    }
  }

  /**
   * Scan a chat's persisted transcript ONCE and fold its worktree-CREATE commands
   * into `chatBranches` (branch→earliest-ts) and its `EnterWorktree` calls into
   * the path claims. This is what rebuilds ownership from history on a fresh boot
   * for trees the registry has no record of — the in-memory maps are empty after
   * a restart, so without this a pre-registry attribution could never re-heal.
   */
  private async ensureHistoryLoaded(project: Project, chatId: string): Promise<void> {
    if (this.historyLoaded.has(chatId)) return;
    this.historyLoaded.add(chatId);
    // `EnterWorktree` calls we've seen but whose result row hasn't come up yet.
    // Scoped to this scan (messages are in order) — the live map is for the bus.
    const openEnters = new Set<string>();
    try {
      // `scanMessages`, NOT `readMessages`: this reads four fields off each row
      // and already treats every one of them as untrusted, so zod-validating the
      // whole discriminated union bought nothing and cost 77% of the scan. On a
      // real store that was a 3.3s freeze across one project's 157 chats, on the
      // first poll tick after a restart — see Store.scanMessages.
      await this.store.scanMessages(chatId, (m) => {
        const kind = m.kind;
        const ts = typeof m.ts === "number" ? m.ts : this.now();
        const toolUseId = typeof m.toolUseId === "string" ? m.toolUseId : "";
        const input =
          m.input && typeof m.input === "object"
            ? (m.input as Record<string, unknown>)
            : undefined;
        if (kind === "tool_result") {
          if (!toolUseId || !openEnters.delete(toolUseId)) return;
          const hit = parseEnterWorktreeResult(m.content);
          if (hit) this.recordWorktreePath(chatId, hit.path, ts);
          return;
        }
        if (kind !== "tool_use") return;
        if (m.name === "EnterWorktree") {
          if (toolUseId) openEnters.add(toolUseId);
          this.recordEnterWorktree(chatId, input, ts);
          return;
        }
        const command = input?.command;
        if (typeof command !== "string" || !command) return;
        if (!looksLikeWorktreeCreate(command)) return;
        this.recordChatBranches(chatId, parseWorktreeBranches(command), ts);
      });
    } catch {
      return;
    }
  }

  /**
   * Turn-complete entry: reconcile the whole project (rewriting each chat's
   * `worktrees[]` to the ones it actually owns), then return just `chatId`'s
   * slice — its attaches/removes this pass.
   */
  async detectForChat(chatId: string): Promise<WorktreeDetectionResult> {
    const empty: WorktreeDetectionResult = { chatId, attached: [], removed: [] };
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return empty;
    const project = await this.store
      .getProject(chat.projectId)
      .catch(() => null);
    if (!project) return empty;
    const results = await this.reconcileProject(project);
    return results.get(chatId) ?? empty;
  }

  /**
   * Rewrite every chat's `worktrees[]` to EXACTLY the live worktrees it owns,
   * reconstructing ownership from transcript history (see `buildBranchOwners`).
   * A wrongly-attributed worktree is moved to its real creator (or dropped if it
   * left disk); a correctly-owned one that's missing is added. Persists the
   * corrected `chat.json` and emits `chat-update` / `worktree-update`.
   */
  private async reconcileProject(
    project: Project,
  ): Promise<Map<string, WorktreeDetectionResult>> {
    const results = new Map<string, WorktreeDetectionResult>();
    const resultFor = (chatId: string): WorktreeDetectionResult => {
      let r = results.get(chatId);
      if (!r) {
        r = { chatId, attached: [], removed: [] };
        results.set(chatId, r);
      }
      return r;
    };

    let infos: WorktreeInfo[];
    try {
      infos = await this.worktrees.list(project);
    } catch {
      // Repo not initialized / transient git failure — nothing to reconcile.
      return results;
    }

    const repoCanon = canonPath(project.repoPath);
    // Live TASK worktrees (drop the primary checkout + bare/detached/unknown).
    const infoByCanon = new Map<string, WorktreeInfo>();
    for (const info of infos) {
      const c = canonPath(info.path);
      if (c === repoCanon) continue;
      if (info.branch.startsWith("(")) continue;
      infoByCanon.set(c, info);
    }

    const projectChats = await this.store
      .listChats(project.id)
      .catch(() => [] as Chat[]);
    // Rebuild each chat's create-history once (empty in memory after a restart).
    for (const c of projectChats) await this.ensureHistoryLoaded(project, c.id);

    const owners = this.buildBranchOwners(project, projectChats, [
      ...infoByCanon.values(),
    ]);

    // Desired live paths per chat (git's current path spelling).
    const desiredByChat = new Map<string, string[]>();
    for (const info of infoByCanon.values()) {
      const owner = owners.get(info.branch);
      if (!owner) continue;
      const arr = desiredByChat.get(owner.chatId) ?? [];
      arr.push(info.path);
      desiredByChat.set(owner.chatId, arr);
      // Push the recovered attribution INTO the registry, so the next pass reads
      // it as fact (tier 0) instead of re-deriving it from transcripts that a
      // future compaction may no longer contain. `via: "record"` is already
      // there; a tier-2 claim also tells us the harness cut this tree, which the
      // back-fill would otherwise have filed as an anonymous `external`.
      if (owner.via === "record") continue;
      await this.worktrees.recordWorktree(
        info.path,
        {
          projectId: project.id,
          branch: info.branch,
          chatId: owner.chatId,
          origin: owner.via === "enter" ? "harness" : "external",
        },
        owner.via === "enter"
          ? { chatId: owner.chatId, origin: "harness" }
          : { chatId: owner.chatId },
      );
    }

    // Rewrite each chat to its desired set (add owned, drop wrong/vanished).
    for (const chat of projectChats) {
      const desired = desiredByChat.get(chat.id) ?? [];
      const desiredCanon = new Set(desired.map(canonPath));
      const currentCanon = new Set(chat.worktrees.map(canonPath));

      const toAdd = desired.filter((p) => !currentCanon.has(canonPath(p)));
      const toRemove = chat.worktrees.filter(
        (p) => !desiredCanon.has(canonPath(p)),
      );
      if (toAdd.length === 0 && toRemove.length === 0) continue;

      const updated = await this.store
        .saveChat({ ...chat, worktrees: desired, updatedAt: this.now() })
        .catch(() => null);
      if (!updated) continue;
      this.bus.publish({ type: "chat-update", chat: updated });

      const r = resultFor(chat.id);
      for (const p of toAdd) {
        this.known.add(canonPath(p));
        r.attached.push(p);
        const info = infoByCanon.get(canonPath(p));
        if (info) {
          this.bus.publish({
            type: "worktree-update",
            chatId: chat.id,
            worktree: { ...info, chatId: chat.id },
          });
        }
      }
      for (const p of toRemove) {
        this.known.delete(canonPath(p));
        r.removed.push(p);
      }
    }

    return results;
  }

  /**
   * Build the authoritative `branch → owner` map for a project, in priority
   * order:
   *   0. The REGISTRY's recorded `chatId` — written when the tree was created, so
   *      there is nothing to infer and nothing may override it.
   *   1. Create-command (history + live tool_use) — EARLIEST creator wins a tie.
   *   2. An `EnterWorktree` claim on the worktree PATH — earliest claimant wins.
   *      Ranked below 1 so switching into another agent's tree can't take it from
   *      whoever's command created it.
   *   3. An existing, unambiguous `chat.worktrees[]` link — how a pre-registry
   *      tree keeps its owner. Recorded on adoption, so it is derived once.
   * A branch no chat claims is absent from the map → left unattached, and shown
   * that way.
   *
   * `via` travels with the owner so the caller can record HOW a tree was
   * attributed: a tier-2 claim means the harness cut it, which is worth knowing
   * when you are looking at a `.claude/worktrees/` tree and wondering why the
   * manager didn't make it.
   */
  private buildBranchOwners(
    project: Project,
    projectChats: Chat[],
    infos: WorktreeInfo[],
  ): Map<string, BranchOwner> {
    const owners = new Map<string, BranchOwner>();
    const projectChatIds = new Set(projectChats.map((c) => c.id));

    // Resolve every `EnterWorktree` claim to a canonical path now that we have a
    // repoPath: chatId → (canonical path → earliest claim ts). The `name` form
    // lands in `<repo>/.claude/worktrees/<name>`, which is where the harness cuts it.
    // A name may legally contain `/` (the harness allows nested segments), so we
    // don't reject separators — we resolve and require the result to stay UNDER
    // the worktrees dir, which drops a `..` that would escape it and claim an
    // arbitrary path elsewhere on disk.
    const wtDir = canonPath(resolve(project.repoPath, ".claude", "worktrees"));
    const claims = new Map<string, Map<string, number>>();
    for (const chatId of new Set([
      ...this.chatWorktreePaths.keys(),
      ...this.chatWorktreeNames.keys(),
    ])) {
      if (!projectChatIds.has(chatId)) continue;
      for (const [cp, ts] of this.chatWorktreePaths.get(chatId) ?? []) {
        earliest(claims, chatId, cp, ts);
      }
      for (const [name, ts] of this.chatWorktreeNames.get(chatId) ?? []) {
        const cp = canonPath(resolve(wtDir, name));
        if (!cp.startsWith(wtDir + sep)) continue;
        earliest(claims, chatId, cp, ts);
      }
    }

    // Existing attribution: canonPath → chatId, but only when a single chat
    // claims it (an ambiguous path is dropped from the tier-3 adoption).
    const currentOwner = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const c of projectChats) {
      for (const p of c.worktrees) {
        const cp = canonPath(p);
        if (currentOwner.has(cp) && currentOwner.get(cp) !== c.id) {
          ambiguous.add(cp);
        } else {
          currentOwner.set(cp, c.id);
        }
      }
    }

    for (const info of infos) {
      // 0. A recorded owner. `list()` merges the registry onto every info, so
      //    this is simply what the tree's creator wrote down.
      if (info.chatId && projectChatIds.has(info.chatId)) {
        owners.set(info.branch, { chatId: info.chatId, via: "record" });
        continue;
      }

      // 1. Earliest create-command owner (scoped to this project's chats).
      let bestChat: string | undefined;
      let bestTs = Number.POSITIVE_INFINITY;
      for (const [chatId, branches] of this.chatBranches) {
        if (!projectChatIds.has(chatId)) continue;
        const ts = branches.get(info.branch);
        if (ts === undefined) continue;
        if (ts < bestTs) {
          bestTs = ts;
          bestChat = chatId;
        }
      }
      if (bestChat) {
        owners.set(info.branch, { chatId: bestChat, via: "command" });
        continue;
      }

      const cp = canonPath(info.path);

      // 2. Earliest `EnterWorktree` claim on this exact path.
      let claimChat: string | undefined;
      let claimTs = Number.POSITIVE_INFINITY;
      for (const [chatId, paths] of claims) {
        const ts = paths.get(cp);
        if (ts === undefined || ts >= claimTs) continue;
        claimTs = ts;
        claimChat = chatId;
      }
      if (claimChat) {
        owners.set(info.branch, { chatId: claimChat, via: "enter" });
        continue;
      }

      // 3. An existing, UNAMBIGUOUS `chat.worktrees[]` entry. Not a guess: some
      //    earlier code path wrote that link down because it knew. This is how a
      //    tree that predates the registry keeps its owner — and because the
      //    reconcile then records it, the adoption happens ONCE and the next pass
      //    reads it as tier 0 rather than re-deriving it forever.
      if (!ambiguous.has(cp) && currentOwner.has(cp)) {
        owners.set(info.branch, { chatId: currentOwner.get(cp)!, via: "adopt" });
      }
    }
    return owners;
  }
}

/** Who owns a branch's worktree, and which tier said so. */
interface BranchOwner {
  chatId: string;
  via: "record" | "command" | "enter" | "adopt";
}

/* =========================================================== command parsing */

const PKG_MANAGERS = new Set(["pnpm", "npm", "yarn", "npx", "bun"]);

/** Cheap gate: does the command create a worktree at all (git add / pnpm worktree)? */
export function looksLikeWorktreeCreate(command: string): boolean {
  if (/\bgit\b[^\n]*\bworktree\b[^\n]*\badd\b/.test(command)) return true;
  return command.split(/[\n&|;]+/).some(runsWorktreeScript);
}

/** Option flags that consume the NEXT token as their value. */
const FLAGS_WITH_VALUE = /^(?:-C|--dir|--filter|-F|-w|--workspace|--prefix)$/;

/**
 * Does this command segment run a package-manager script literally NAMED
 * `worktree` (`pnpm worktree feat/x`, `npm run worktree x`, `pnpm -C repo
 * worktree x`)?
 *
 * This used to be `/\b(pnpm|npm|…)\b[^\n&|;]*\bworktree\b/` — a package manager
 * followed by the word "worktree" ANYWHERE in the rest of the segment. That
 * matched far more than it meant to: `npx vitest run …/worktree-reaper.test.ts`
 * is a read-only test run, and the guard refused it because the word appears in
 * a FILENAME. Anyone working on worktree code was blocked from running the tests
 * for the code they were working on.
 *
 * So the match is now positional: `worktree` has to be the first non-flag token
 * after the package manager (past `run` / `exec`), which is the only position
 * that makes it a script name rather than an argument.
 */
function runsWorktreeScript(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // `FOO=bar pnpm worktree x` — step over leading env assignments.
  while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  const pm = tokens[i];
  if (!pm) return false;
  // Tolerate an absolute path to the binary, and a `.cmd`/`.exe` shim.
  const name = pm.split(/[/\\]/).pop()!.replace(/\.(cmd|exe|ps1)$/i, "");
  if (!PKG_MANAGERS.has(name)) return false;
  i++;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "run" || tok === "run-script" || tok === "exec") {
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      i++;
      // `-C <dir>` style: the value is a separate token, not an argument yet.
      if (FLAGS_WITH_VALUE.test(tok)) i++;
      continue;
    }
    // The first real argument. It is the script name — or it isn't.
    return tok === "worktree";
  }
  return false;
}

/** Strip one layer of surrounding matching quotes from a shell token. */
function stripQuotes(tok: string): string {
  const t = tok.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Extract the branch name(s) a command creates. Handles chained commands
 * (`… && …`) and both house shapes:
 *   - `git worktree add … -b <branch> …`  (also `-B`)
 *   - `pnpm worktree <branch>`            (also `pnpm run worktree`, `npm`/`yarn`,
 *                                          and a leading `-C <dir>` etc.)
 * The branch here matches what `git worktree list --porcelain` reports (e.g.
 * `feat/x`), so detection can attribute by exact branch.
 */
export function parseWorktreeBranches(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(stripQuotes);
    if (tokens.length === 0) continue;
    const first = tokens[0];

    if (first === "git") {
      if (!tokens.includes("worktree") || !tokens.includes("add")) continue;
      for (let i = 0; i < tokens.length; i++) {
        if ((tokens[i] === "-b" || tokens[i] === "-B") && i + 1 < tokens.length) {
          const b = tokens[i + 1];
          if (b && !b.startsWith("-")) out.push(b);
        }
      }
    } else if (PKG_MANAGERS.has(first)) {
      const wtIdx = tokens.indexOf("worktree");
      if (wtIdx < 0) continue;
      // First non-flag token after `worktree` (skipping `run`/`add`) is the branch.
      for (let i = wtIdx + 1; i < tokens.length; i++) {
        const b = tokens[i];
        if (b === "run" || b === "add") continue;
        if (b.startsWith("-")) continue;
        out.push(b);
        break;
      }
    }
  }
  return [...new Set(out)];
}
