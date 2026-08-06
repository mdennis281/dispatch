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
 * just completed". Ownership is reconstructed from each chat's OWN transcript:
 * we scan its persisted `tool_use` rows (+ the live `chat-message` bus) for a
 * worktree-CREATE command (`git worktree add -b <branch>` / `pnpm worktree
 * <branch>`) and record `chatId → branch → earliest-ts`. That yields a global
 * `branch → owning-chat` map (earliest creator wins a tie); fallbacks cover a
 * branch with no create-command (a chat whose history referenced the worktree
 * PATH, then a chat whose persisted `prs[]` carries the branch, then an existing
 * unambiguous attribution — never overriding a stronger signal). A branch with
 * no owner is LEFT UNATTACHED rather than dumped on an arbitrary chat.
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
import { resolve } from "node:path";
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
  /** chatId → (branch → earliest epoch ms it CREATED it), from history + live tool_use. */
  private readonly chatBranches = new Map<string, Map<string, number>>();
  /** chatId → canonical worktree paths its history referenced (fallback attribution). */
  private readonly chatPathRefs = new Map<string, Set<string>>();
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
   * into `chatBranches` (branch→earliest-ts) + `chatPathRefs` (referenced worktree
   * paths, for fallback attribution). This is what rebuilds ownership from history
   * on a fresh boot — the in-memory `chatBranches` is empty after a restart, so
   * without this the persisted (possibly-wrong) attribution could never re-heal.
   */
  private async ensureHistoryLoaded(project: Project, chatId: string): Promise<void> {
    if (this.historyLoaded.has(chatId)) return;
    this.historyLoaded.add(chatId);
    let messages: ChatMessage[];
    try {
      messages = await this.store.readMessages(chatId);
    } catch {
      return;
    }
    const rootCanon = canonPath(
      resolve(project.repoPath, project.worktreeRoot),
    );
    for (const m of messages) {
      if (m.kind !== "tool_use") continue;
      const command = (m.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== "string" || !command) continue;
      // Path references (`cd <worktree>` …): any token under the worktree root is
      // a signal this chat worked in that worktree (tier-2 fallback).
      for (const token of command.split(/\s+/)) {
        const t = token.replace(/^["']|["']$/g, "");
        if (!t) continue;
        const c = canonPath(t);
        if (c === rootCanon || !c.startsWith(rootCanon)) continue;
        let refs = this.chatPathRefs.get(chatId);
        if (!refs) {
          refs = new Set<string>();
          this.chatPathRefs.set(chatId, refs);
        }
        refs.add(c);
      }
      if (!looksLikeWorktreeCreate(command)) continue;
      this.recordChatBranches(
        chatId,
        parseWorktreeBranches(command),
        m.ts ?? this.now(),
      );
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

    const owners = this.buildBranchOwners(projectChats, [
      ...infoByCanon.values(),
    ]);

    // Desired live paths per chat (git's current path spelling).
    const desiredByChat = new Map<string, string[]>();
    for (const info of infoByCanon.values()) {
      const owner = owners.get(info.branch);
      if (!owner) continue;
      const arr = desiredByChat.get(owner) ?? [];
      arr.push(info.path);
      desiredByChat.set(owner, arr);
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
   * Build the authoritative `branch → owning-chatId` map for a project from each
   * chat's OWN signals, in priority order:
   *   1. Create-command (history + live tool_use) — EARLIEST creator wins a tie.
   *   2. A chat whose history referenced the worktree PATH (`cd <path>` …).
   *   3. A chat whose persisted `prs[]` carries a PR on that branch.
   *   4. An existing, UNAMBIGUOUS attribution (covers manager-created worktrees
   *      with no transcript signal) — only reached when 1–3 are silent, so it can
   *      never override a real creator and re-introduce the mis-attribution bug.
   * A branch no chat claims is absent from the map → left unattached.
   */
  private buildBranchOwners(
    projectChats: Chat[],
    infos: WorktreeInfo[],
  ): Map<string, string> {
    const owners = new Map<string, string>();
    const projectChatIds = new Set(projectChats.map((c) => c.id));

    // Existing attribution: canonPath → chatId, but only when a single chat claims
    // it (an ambiguous path is dropped from the tier-4 fallback).
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
        owners.set(info.branch, bestChat);
        continue;
      }

      // 2. A chat whose history referenced this worktree path.
      const cp = canonPath(info.path);
      const pathRef = projectChats.find((c) =>
        this.chatPathRefs.get(c.id)?.has(cp),
      );
      if (pathRef) {
        owners.set(info.branch, pathRef.id);
        continue;
      }

      // 3. A chat with a persisted PR on this branch.
      const prOwner = projectChats.find((c) =>
        (c.prs ?? []).some((r) => r.branch === info.branch),
      );
      if (prOwner) {
        owners.set(info.branch, prOwner.id);
        continue;
      }

      // 4. Preserve an existing, unambiguous attribution.
      if (!ambiguous.has(cp) && currentOwner.has(cp)) {
        owners.set(info.branch, currentOwner.get(cp)!);
      }
    }
    return owners;
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
