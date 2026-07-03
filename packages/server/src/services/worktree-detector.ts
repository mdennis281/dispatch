/**
 * WorktreeDetector — attributes AGENT-created git worktrees to the chat that
 * created them.
 *
 * Worktrees in this system are made BY THE AGENT: inside a turn it runs
 * `pnpm worktree <branch>` / `git worktree add …` via Bash (cwd = the project's
 * repoPath), NOT by the user through the manager, and a single chat turn may
 * create SEVERAL. Nothing on the wire announces them, so the manager has to
 * DISCOVER them: we list the project's live `git worktree list --porcelain`,
 * diff it against the set we've already accounted for, and attribute any
 * newcomer to the chat that CREATED it — through the same `attachToChat` link
 * path `create()` uses (saveChat + chat-update + worktree-update). Worktrees the
 * agent has torn down are detached.
 *
 * ATTRIBUTION (bug fix). Detection is project-wide, not "whatever chat's turn
 * just completed". We record, per chat, the branch(es) that chat's session
 * created by parsing its Bash `tool_use` rows (`git worktree add -b <branch>` /
 * `pnpm worktree <branch>`), fed off the `chat-message` bus. A detected worktree
 * is attached to the chat whose recorded branch matches it. When the branch is
 * unknown we fall back to the currently-active chat that most recently ran a
 * worktree command (or, on a turn-complete pass, the completing chat if it ran
 * one); with no such chat the worktree is LEFT UNATTACHED rather than dumped on
 * an arbitrary chat. A worktree already owned by a chat is never re-attributed.
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
import { resolve } from "node:path";
import type {
  Chat,
  ChatMessage,
  ChatStatus,
  Project,
  WorktreeInfo,
} from "@cm/shared";
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
    status === "running" || status === "queued" || status === "awaiting-input"
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
  /** chatId → branch names that chat's session created (from tool_use rows). */
  private readonly chatBranches = new Map<string, Set<string>>();
  /** chatId → epoch ms it last ran a worktree-creating command (fallback rank). */
  private readonly lastWorktreeCmdAt = new Map<string, number>();
  /** Chats whose session is currently active (drives polling + fallback). */
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
    if (message.kind !== "tool_use") return;
    const command = message.input?.command;
    if (typeof command !== "string" || !command) return;
    if (!looksLikeWorktreeCreate(command)) return;
    // Record the branch(es) this chat created + when, so detection can attribute
    // a matching worktree to it (not to whoever's turn happens to complete first).
    this.lastWorktreeCmdAt.set(chatId, message.ts ?? this.now());
    let set = this.chatBranches.get(chatId);
    for (const branch of parseWorktreeBranches(command)) {
      if (!set) {
        set = new Set<string>();
        this.chatBranches.set(chatId, set);
      }
      set.add(branch);
    }
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
    void this.enqueue(() => this.pollActiveProjects()).finally(() => {
      this.pollInFlight = false;
    });
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
      if (project) await this.reconcileProject(project);
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

  /**
   * Turn-complete entry: reconcile the whole project (attributing each newcomer
   * to the chat that created it), then return just `chatId`'s slice. `chatId` is
   * the preferred fallback owner (it just ran, demonstrably), but branch-matched
   * worktrees still go to their real creators, not to `chatId`.
   */
  async detectForChat(chatId: string): Promise<WorktreeDetectionResult> {
    const empty: WorktreeDetectionResult = { chatId, attached: [], removed: [] };
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return empty;
    const project = await this.store
      .getProject(chat.projectId)
      .catch(() => null);
    if (!project) return empty;
    const results = await this.reconcileProject(project, {
      preferChatId: chatId,
    });
    return results.get(chatId) ?? empty;
  }

  /**
   * Diff a project's live worktrees against everything we've accounted for:
   * attach each newcomer to the chat that CREATED it, detach any that vanished
   * from disk, and fold owned newcomers back into `known`. Unattributable
   * newcomers are LEFT OUT of `known` so a later pass (once its branch record or
   * an active chat appears) can still pick them up.
   */
  private async reconcileProject(
    project: Project,
    opts: { preferChatId?: string } = {},
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
    const currentCanon = new Set(infos.map((i) => canonPath(i.path)));

    // Snapshot every chat in the project so we never steal a worktree another
    // chat already owns, and so removals can be reconciled project-wide.
    const projectChats = await this.store
      .listChats(project.id)
      .catch(() => [] as Chat[]);
    const projectChatIds = new Set(projectChats.map((c) => c.id));
    const ownerByPath = new Map<string, string>();
    for (const c of projectChats) {
      for (const p of c.worktrees) ownerByPath.set(canonPath(p), c.id);
    }

    // Attribute newcomers to their creators.
    for (const info of infos) {
      const c = canonPath(info.path);
      if (c === repoCanon) continue; // the primary checkout is never a task worktree
      if (info.branch === "(bare)") continue; // a bare parent, not a worktree
      if (this.known.has(c)) continue; // pre-existing / already attributed
      if (ownerByPath.has(c)) continue; // already owned by some chat

      const ownerChatId = this.attributeWorktree(
        info,
        projectChatIds,
        projectChats,
        opts.preferChatId,
      );
      // Unknown creator → leave unattached AND out of `known`, so a later pass
      // (branch record / active chat arrives) can still attribute it.
      if (!ownerChatId) continue;

      const linked = await this.worktrees.attachToChat(ownerChatId, info.path);
      this.known.add(c);
      ownerByPath.set(c, ownerChatId);
      if (linked) {
        resultFor(ownerChatId).attached.push(info.path);
        this.bus.publish({
          type: "worktree-update",
          chatId: ownerChatId,
          worktree: { ...info, chatId: ownerChatId },
        });
      }
    }

    // Removals: an attached worktree no longer on disk → detach it wherever it
    // was recorded, and forget it so a recreation at the same path re-detects.
    for (const c of projectChats) {
      for (const p of c.worktrees) {
        if (currentCanon.has(canonPath(p))) continue;
        const detached = await this.worktrees.detachFromChat(c.id, p);
        this.known.delete(canonPath(p));
        if (detached) resultFor(c.id).removed.push(p);
      }
    }

    return results;
  }

  /**
   * Decide which chat owns a newly-seen worktree.
   *   1. The chat whose recorded branch matches the worktree's branch (the
   *      creator) — the authoritative signal.
   *   2. Fallback: the chat that most recently ran a worktree command, limited to
   *      the just-completed chat (`preferChatId`) or a currently-active chat.
   *   3. Else `undefined` — leave it unattached (don't dump on an arbitrary chat).
   */
  private attributeWorktree(
    info: WorktreeInfo,
    projectChatIds: Set<string>,
    projectChats: Chat[],
    preferChatId?: string,
  ): string | undefined {
    // 1. Branch match, scoped to a chat that belongs to THIS project.
    for (const [chatId, branches] of this.chatBranches) {
      if (projectChatIds.has(chatId) && branches.has(info.branch)) return chatId;
    }

    // 2. Most-recent worktree command among eligible (active / just-completed) chats.
    let best: string | undefined;
    let bestTs = Number.NEGATIVE_INFINITY;
    for (const c of projectChats) {
      const ts = this.lastWorktreeCmdAt.get(c.id);
      if (ts === undefined) continue;
      const eligible = c.id === preferChatId || this.activeChats.has(c.id);
      if (!eligible) continue;
      if (ts > bestTs) {
        bestTs = ts;
        best = c.id;
      }
    }
    return best;
  }
}

/* =========================================================== command parsing */

const PKG_MANAGERS = new Set(["pnpm", "npm", "yarn", "npx", "bun"]);

/** Cheap gate: does the command create a worktree at all (git add / pnpm worktree)? */
export function looksLikeWorktreeCreate(command: string): boolean {
  if (/\bgit\b[^\n]*\bworktree\b[^\n]*\badd\b/.test(command)) return true;
  return /\b(?:pnpm|npm|yarn|npx|bun)\b[^\n&|;]*\bworktree\b/.test(command);
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
