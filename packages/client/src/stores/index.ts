/**
 * Store barrel + the two integration seams the rest of the app uses:
 *
 *   hydrateFromMock() — seed every store from the offline fixture so the shell
 *                       renders realistically with no backend (today).
 *   applyServerEvent() — the single reducer that maps a parsed WsServerEvent to
 *                       the right store mutation. lib/ws.ts calls this for every
 *                       frame; 2b keeps the fixture seed OR replaces it with a
 *                       REST snapshot, but this dispatch path is already live.
 */
import type {
  WsServerEvent,
  WorktreeInfo,
  PRInfo,
  WorkflowRun,
  AttentionItem,
} from "@dispatch/shared";

import { api } from "../lib/api.js";
import {
  notifyAttention,
  syncChatNotification,
  closeChatNotification,
  setAttentionBadge,
} from "../lib/browserNotify.js";
import { useConnection } from "./connection.js";
import { useProjects } from "./projects.js";
import { useChats, statusIsActivity } from "./chats.js";
import { reconcileActiveChat } from "./navigation.js";
import { useMessages } from "./messages.js";
import { useAttention } from "./attention.js";
import { useRunners } from "./runners.js";
import { useTerminals } from "./terminals.js";
import { usePanels } from "./panels.js";
import { usePrs } from "./prs.js";
import { useMemory } from "./memory.js";
import { useMcp } from "./mcp.js";
import { useConfig } from "./config.js";
import { useCheckpoints } from "./checkpoints.js";
import { useNotices } from "./notices.js";
import { useUsage } from "./usage.js";
import { useUpdate } from "./update.js";
import { useModels } from "./models.js";
import { useSettings } from "./settings.js";
import { useHarnesses } from "./harnesses.js";

import {
  MOCK_PROJECTS,
  MOCK_AGENTS,
  MOCK_MODES,
  MOCK_CHATS,
  MOCK_MESSAGES,
  MOCK_ATTENTION,
  MOCK_RUNNERS,
  MOCK_RUNNER_LOGS,
  MOCK_WORKTREES,
  MOCK_WORKTREE_DIFF,
  MOCK_PRS,
  MOCK_WORKFLOW_RUNS,
} from "../lib/mock.js";

export { useConnection } from "./connection.js";
export type { ConnState } from "./connection.js";
export { useProjects, useActiveProject } from "./projects.js";
export { useChats, useProjectChats } from "./chats.js";
export { useMessages, useChatMessages, useChatPage, useStreamRows } from "./messages.js";
export type { StreamRow, ChatPage } from "./messages.js";
export { useAttention, useAttentionCount } from "./attention.js";
export { useRunners, useChatRunners } from "./runners.js";
export { useTerminals, useChatTerminals } from "./terminals.js";
export { usePanels } from "./panels.js";
export { usePrs, useAllPrs, selectPrs } from "./prs.js";
export { useMemory, useProjectMemories } from "./memory.js";
export { useGit, useGitChangeCount, changeCount } from "./git.js";
export type { GitSelection, GitTab } from "./git.js";
export { useCheckpoints, useHasCheckpoint } from "./checkpoints.js";
export { useNotices } from "./notices.js";
export type { Toast, NoticeLevel } from "./notices.js";
export { useUsage } from "./usage.js";
export { useUpdate } from "./update.js";
export { useModels } from "./models.js";
export { useSettings } from "./settings.js";
export { useHarnesses } from "./harnesses.js";
export { useTheme, watchSystemTheme } from "./theme.js";
export type { ThemePref, ResolvedTheme } from "./theme.js";

/** Seed all stores from the offline fixture (call once at boot). */
export function hydrateFromMock(): void {
  useProjects.getState().hydrate({
    projects: MOCK_PROJECTS,
    agents: MOCK_AGENTS,
    modes: MOCK_MODES,
  });
  useChats.getState().hydrate(MOCK_CHATS);
  useMessages.getState().hydrate(MOCK_MESSAGES);
  useAttention.getState().hydrate(MOCK_ATTENTION);
  useRunners.getState().hydrate(MOCK_RUNNERS, MOCK_RUNNER_LOGS);
  usePanels.getState().hydrate({
    worktrees: MOCK_WORKTREES,
    diffs: MOCK_WORKTREE_DIFF,
    prs: MOCK_PRS,
    workflowRuns: MOCK_WORKFLOW_RUNS,
  });
}

/**
 * One chat's outstanding items, most-urgent-first (the store keeps `items`
 * sorted). Drives the "+N more" count on that chat's single OS notification.
 */
function itemsForChat(chatId: string): AttentionItem[] {
  return useAttention.getState().items.filter((i) => i.chatId === chatId);
}

/**
 * The one reducer: apply a server event to the stores. Exhaustive over
 * WsServerEvent so a new event type is a compile error until it's handled.
 */
export function applyServerEvent(evt: WsServerEvent): void {
  switch (evt.type) {
    case "hello":
      useConnection.getState().onHello(evt.serverTime, evt.version);
      // (Re)hydrate the authoritative REST snapshot on every connect — the very
      // first one primes the app; a reconnect resyncs after a server restart.
      void hydrateFromServer();
      return;

    case "chat-message":
      useMessages.getState().append(evt.chatId, evt.message);
      // A chat streaming in the BACKGROUND has no viewport to disturb, so its
      // window can be capped right here — otherwise every chat that ran this
      // session keeps every row it ever emitted, and `evictExcept` (chat switch
      // only) may not run for hours. The ACTIVE chat is trimmed by ChatView
      // instead, which knows whether the reader is pinned to the bottom.
      if (evt.chatId !== useChats.getState().activeChatId) {
        useMessages.getState().trimWindow(evt.chatId);
      }
      useChats.getState().bumpActivity(evt.chatId, evt.message.ts);
      return;

    case "message-chunk":
      useMessages.getState().chunk(evt.chatId, evt.messageId, evt.delta, evt.channel);
      useChats.getState().bumpActivity(evt.chatId);
      return;

    case "chat-status":
      useChats
        .getState()
        .setStatus(evt.chatId, evt.status, evt.activity, evt.queued, evt.prSettled);
      // Not every status is the chat doing something — `broker.stop()` settles a
      // session to `done`/`idle` on behalf of the Power button and the idle
      // sweep, and bumping on those reset the row's age to "now" for something
      // the human did TO the chat rather than in it. See `statusIsActivity`.
      if (statusIsActivity(evt.status)) useChats.getState().bumpActivity(evt.chatId);
      // Only a `running` turn has an in-flight assistant stream. Any other state
      // — blocked on input, queued, or finished (idle/done/error) — means no live
      // stream, so clear lingering streaming buffers: a partial/aborted message's
      // text can't strand a stuck StreamingRow (perpetual ●●●) under a finished
      // section, whether the turn blocked on a prompt or ended outright.
      if (evt.status !== "running") {
        useMessages.getState().clearStreaming(evt.chatId);
      }
      // True turn-end (not merely blocked on input): the agent likely just touched
      // the repo (edits, commits, a PR). Re-pull the active project's worktrees /
      // diffs / PRs so those panels reflect reality without a manual page refresh.
      if (evt.status === "idle" || evt.status === "done" || evt.status === "error") {
        scheduleTurnEndRefresh(evt.chatId);
      }
      return;

    case "chat-exemptions":
      useChats.getState().setExemptions(evt.chatId, evt.exemptions);
      return;

    case "permission-request":
      // Synthesize the inline pending permission card immediately (the server
      // only persists the `permission` row once it's resolved). The attention
      // item rides a separate `attention-add`. The later resolved row replaces
      // this one in place (deduped by requestId in messages.append).
      useMessages.getState().upsertPermissionRequest(evt.chatId, evt.request);
      return;

    case "permission-resolved":
      useMessages.getState().resolvePermission(evt.chatId, evt.requestId, evt.decision);
      return;

    case "server-shutdown":
      // Deliberate stop, not a dropped link. Recording it is what tells the WS
      // client to stop reconnecting and the shell to show the stopped screen.
      useConnection.getState().onServerShutdown(evt.reason);
      return;

    case "attention-add": {
      useAttention.getState().add(evt.item);
      // …and, if you're not looking at the app, as an OS notification. Fired
      // here rather than from a component so it doesn't depend on which view
      // happens to be mounted. Never awaited: delivery is best-effort.
      const title = useChats.getState().byId[evt.item.chatId]?.title;
      const outstanding = itemsForChat(evt.item.chatId).length;
      void notifyAttention(evt.item, title, outstanding);
      void setAttentionBadge(useAttention.getState().items.length);
      return;
    }

    case "attention-resolve": {
      // The event's chatId is optional, so read the owner off the item we still
      // hold before dropping it — otherwise there is nothing left to re-render.
      const chatId =
        evt.chatId ?? useAttention.getState().items.find((i) => i.id === evt.id)?.chatId;
      useAttention.getState().resolve(evt.id);
      // Answered elsewhere (or by you, in-app) — withdraw the OS toast so the
      // notification centre doesn't hold decisions that are already made. If the
      // chat still has other items, the toast is corrected rather than removed.
      if (chatId) {
        const title = useChats.getState().byId[chatId]?.title;
        void syncChatNotification(chatId, itemsForChat(chatId), title);
      }
      void setAttentionBadge(useAttention.getState().items.length);
      return;
    }

    case "runner-log":
      useRunners.getState().appendLog(evt.runnerId, {
        stream: evt.stream,
        line: evt.line,
        ts: evt.ts,
      });
      return;

    case "runner-update":
      useRunners.getState().upsert(evt.runner);
      return;

    case "pr-update":
      usePanels.getState().upsertPr(evt.pr);
      return;

    // The catalog's live feed. Distinct from `pr-update` above, which is a
    // chat-scoped one-shot keyed by PR NUMBER — numbers collide across repos,
    // which is why the project-wide roster could never fold that one in.
    case "pr-record-update":
      usePrs.getState().upsert(evt.record);
      return;

    case "workflow-update":
      usePanels.getState().upsertRun(evt.run);
      return;

    case "worktree-update":
      usePanels.getState().upsertWorktree(evt.worktree);
      return;

    case "terminal-update":
      useTerminals.getState().upsert(evt.terminal);
      return;

    case "terminal-output":
      useTerminals.getState().appendLine(evt.terminalId, {
        stream: evt.stream,
        chunk: evt.chunk,
        ts: evt.ts,
      });
      return;

    case "terminal-closed":
      useTerminals.getState().close(evt.terminalId);
      return;

    case "checkpoint":
      // Rollback anchor — record it so the chat can offer "Roll back here" only
      // where a restore point exists.
      useCheckpoints.getState().add(evt.chatId, evt.messageId);
      return;

    case "chat-update":
      useChats.getState().upsertChat(evt.chat);
      return;

    case "chat-deleted":
      // Authoritative deletion: drop the chat everywhere (sidebar reselects a
      // sibling) + clear any stray attention items. Idempotent, so it's a safe
      // backstop for the initiating tab and the real signal for every other tab.
      void closeChatNotification(evt.chatId);
      useAttention.getState().clearChat(evt.chatId);
      useChats.getState().removeChat(evt.chatId);
      void setAttentionBadge(useAttention.getState().items.length);
      return;

    case "project-update":
      useProjects.getState().upsertProject(evt.project);
      return;

    case "project-config-update":
      // A managed repo's `.dispatch/` config was (re)loaded. Phase 1 syncs
      // the store (a `project-update` follows when authored fields change). Feed
      // the Project config view's store so it live-updates on a watcher edit /
      // scaffold / import. Refresh the agent/mode picker lists so config-authored
      // agents/modes appear/update live after an edit to `.dispatch/` (no
      // restart, next turn picks up).
      useConfig.getState().set(evt.projectId, {
        sourceDir: evt.sourceDir,
        config: evt.config,
        errors: evt.errors,
      });
      void Promise.all([api.agents.list(), api.modes.list()])
        .then(([agents, modes]) =>
          useProjects.getState().setConfigLists({ agents, modes }),
        )
        .catch(() => {
          /* best-effort — the next hydrate/reconnect will resync the pickers */
        });
      return;

    case "memory-update":
      // A memory was created/updated (agent `remember` or a panel edit) — upsert
      // it so the Memory panel live-updates without a refetch.
      useMemory.getState().upsert(evt.memory);
      return;

    case "memory-deleted":
      useMemory.getState().remove(evt.projectId, evt.name);
      return;

    case "usage-update":
      // Server polled subscription usage (5h + weekly) — refresh the header meter.
      useUsage.getState().set(evt.usage);
      return;

    case "update-available":
      // The poller found a newer release. Pushed rather than polled by the
      // client because the check runs on an hours-long interval, and a tab left
      // open would otherwise never learn about it.
      useUpdate.getState().set(evt.status);
      return;

    case "notice":
      useNotices.getState().push({
        level: evt.level,
        text: evt.text,
        chatId: evt.chatId,
      });
      return;

    // Consumed by `WsClient` before it ever reaches this reducer — it is about
    // one socket's liveness, not about any store. Present so the exhaustive
    // check below keeps meaning something.
    case "pong":
      return;

    case "error":
      useNotices.getState().push({
        level: "error",
        text: evt.message,
        detail: evt.detail,
        chatId: evt.chatId,
      });
      return;

    default: {
      const _exhaustive: never = evt;
      void _exhaustive;
      return;
    }
  }
}

/* =============================================================== live data */

/** Chats whose transcript we've already fetched this session (reset on hydrate). */
const loadedChats = new Set<string>();

// Coalesced turn-end refresh of the ACTIVE project's panels (worktrees/diffs/PRs).
// Multiple chats finishing close together collapse into one refetch.
let turnEndRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let turnEndRefreshProject: string | null = null;

/** Refresh the active project's panels shortly after one of its chats' turns ends. */
function scheduleTurnEndRefresh(chatId: string): void {
  const projectId = useChats.getState().byId[chatId]?.projectId ?? null;
  // Only refresh what the user is actually looking at; a switch re-hydrates the rest.
  if (!projectId || projectId !== useProjects.getState().activeProjectId) return;
  turnEndRefreshProject = projectId;
  if (turnEndRefreshTimer) return;
  turnEndRefreshTimer = setTimeout(() => {
    turnEndRefreshTimer = null;
    const pid = turnEndRefreshProject;
    turnEndRefreshProject = null;
    if (pid) void loadProjectPanels(pid);
  }, 400);
}

/**
 * REST-hydrate the authoritative snapshot into every store. Config lists always
 * load; the per-project/per-chat deep views (worktrees, PRs, Actions, transcript)
 * load best-effort so a slow/failed `git`/`gh` never blocks the app. Preserves
 * the user's active project/chat across a reconnect. Returns false only when the
 * core lists are unreachable (backend down) — the caller then keeps the mock.
 */
export async function hydrateFromServer(): Promise<boolean> {
  let projects, agents, modes, chats, attention, runners, terminals, prs;
  try {
    [projects, agents, modes, chats, attention, runners, terminals, prs] = await Promise.all([
      api.projects.list(),
      api.agents.list(),
      api.modes.list(),
      api.chats.list(),
      api.attention.list(),
      api.runners.list(),
      api.terminals.list().catch(() => []),
      // The PR catalog. Non-gating like the terminals roster, and cheap: it's a
      // read of the server's own store, not a `gh` call — which is exactly why
      // the PRs tab can render on open with no fetch of its own.
      api.prs.list().catch(() => []),
    ]);
  } catch {
    return false;
  }

  const prevProject = useProjects.getState().activeProjectId;
  const prevChat = useChats.getState().activeChatId;

  // Every chat has to re-read its transcript from the server, because we stopped
  // receiving its events for however long the socket was down. Mark them all
  // unloaded — but DON'T drop the windows themselves (see below); the resident
  // rows are what `setForChat` splices the fresh snapshot into.
  loadedChats.clear();
  useProjects.getState().hydrate({ projects, agents, modes });
  // Best-effort: refresh the composer's model picker from the server, which
  // reads the live list off the Claude Code runtime. Kept out of the gating
  // fetch above because that read spawns a short-lived probe subprocess and must
  // never block the app — the store keeps its fallback seed on failure.
  void api.models
    .list("claude")
    .then((m) => useModels.getState().setModels(m, "claude"))
    .catch(() => {});
  void api.harnesses
    .list()
    .then((h) => useHarnesses.getState().setHarnesses(h))
    .catch(() => {});
  // Same treatment for the app settings the transcript consults (the
  // injected-context default): best-effort, never gating, and it falls back to
  // "off" — which is also what the setting defaults to server-side.
  void api.settings
    .get()
    .then((s) => {
      useSettings.getState().apply(s);
      const harness = s.harness?.defaultHarness ?? "claude";
      return api.models
        .list(harness)
        .then((models) => useModels.getState().setModels(models, harness));
    })
    .catch(() => {});
  // Whether a newer release exists. Best-effort and never gating: an older
  // server has no /api/update at all, and the surfaces all render nothing
  // until a status arrives. Live `update-available` events keep it fresh.
  void useUpdate.getState().load();
  useChats.getState().hydrate(chats);
  useAttention.getState().hydrate(attention);
  // The badge is OS state that outlives the page: a launch that found nothing
  // waiting has to actively clear the count a previous session left on the icon.
  void setAttentionBadge(attention.length);
  useRunners.getState().hydrate(runners, {});
  useTerminals.getState().hydrate(terminals, {});
  usePrs.getState().hydrate(prs);
  // NOT `useMessages.hydrate({})`. Blanking every transcript here is what made a
  // reconnect feel like a page refresh: the open chat's rows went to `[]`, the
  // scroll container collapsed, and the refetch below landed the reader back at
  // the bottom of a chat they were reading the middle of. The windows stay; the
  // refetch reconciles them in place. Only the streaming buffers have to go —
  // nothing will ever deliver the rest of a delta we stopped listening for.
  useMessages.getState().resetStreaming();
  useCheckpoints.getState().reset();
  useMemory.getState().reset();
  useMcp.getState().reset();
  useConfig.getState().reset();
  usePanels.getState().hydrate({ worktrees: [], diffs: {}, prs: [], workflowRuns: [] });

  // Keep the user where they were after a reconnect.
  if (prevProject && projects.some((p) => p.id === prevProject)) {
    useProjects.getState().setActiveProject(prevProject);
  }
  if (prevChat && chats.some((c) => c.id === prevChat)) {
    useChats.getState().setActiveChat(prevChat);
  }
  // The two hydrates above pick their selections from independent lists (the
  // remembered-or-first project, and the globally-most-recent chat), so on a
  // first load they can land in different projects. Snap the chat back into the
  // focused project.
  reconcileActiveChat();

  const activeProject = useProjects.getState().activeProjectId;
  if (activeProject) void loadProjectPanels(activeProject);
  const activeChat = useChats.getState().activeChatId;
  if (activeChat) void ensureChatMessages(activeChat);
  // …and re-read whether that chat is running with a guard lifted. The store
  // dropped every exemption on hydrate (see `useChats.hydrate`), so without this
  // a reconnect leaves an unguarded chat looking guarded until the next grant.
  if (activeChat) void loadExemptions(activeChat);

  // Re-materialize open permission/question cards dropped by the transcript wipe
  // above (see {@link restorePendingPermissions}).
  void restorePendingPermissions();

  return true;
}

/**
 * Re-read one chat's live guard exemptions from the server.
 *
 * A REST read rather than something the WS snapshot carries, for the same reason
 * `context-usage` is one: this is live-session state with no persistent home, so
 * the only place it exists is the broker. Best-effort — a failed read leaves the
 * previous answer rather than falsely clearing the chip.
 */
export async function loadExemptions(chatId: string): Promise<void> {
  try {
    useChats.getState().setExemptions(chatId, await api.chats.exemptions(chatId));
  } catch {
    /* keep whatever we last knew */
  }
}

/**
 * How many rows an initial transcript open pulls. The transcript is a WINDOW, not
 * the whole history: a long chat runs to thousands of rows / megabytes, and both
 * the fetch and the resulting DOM scale with it. Older rows page in on scroll.
 */
export const TRANSCRIPT_PAGE_SIZE = 150;

/** How many chats' transcripts stay resident (LRU) before older ones are evicted. */
const TRANSCRIPT_CACHE_SIZE = 3;

/** Most-recently-opened chat ids, newest first (drives transcript eviction). */
let recentChats: string[] = [];

/** Record a chat open and drop transcripts beyond the LRU window. */
function touchChat(chatId: string): void {
  recentChats = [chatId, ...recentChats.filter((id) => id !== chatId)].slice(
    0,
    TRANSCRIPT_CACHE_SIZE,
  );
  const keep = new Set(recentChats);
  // A chat that's been evicted must re-fetch on its next open, so drop its
  // "already loaded" mark in lockstep with the store eviction.
  for (const id of loadedChats) if (!keep.has(id)) loadedChats.delete(id);
  useMessages.getState().evictExcept(recentChats);
}

/**
 * Re-materialize the inline cards for permission/question requests that are
 * still open on the server, optionally narrowed to one chat.
 *
 * These cards are synthesized client-side from the transient `permission-request`
 * event and are only PERSISTED once resolved, so anything that (re)builds a
 * transcript from the REST snapshot drops them — a reconnect, and equally an
 * ordinary chat re-open after LRU eviction. Left un-restored, the chat sits at
 * "Awaiting input" with its tool card spinning and no card to answer, and the
 * blocked tool can never be released.
 *
 * `upsertPermissionRequest` is idempotent and `setForChat` carries these
 * (absent-from-snapshot) rows, so it's safe regardless of load ordering.
 * Best-effort: a failed snapshot just means no re-materialized cards.
 */
export async function restorePendingPermissions(chatId?: string): Promise<void> {
  try {
    const reqs = await api.attention.pendingPermissions();
    for (const r of reqs) {
      if (chatId && r.chatId !== chatId) continue;
      useMessages.getState().upsertPermissionRequest(r.chatId, r);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Lazily fetch the NEWEST page of a chat's transcript + its rollback anchors
 * (once per session, until evicted). Older rows load on demand via
 * {@link loadOlderMessages}.
 */
export async function ensureChatMessages(chatId: string): Promise<void> {
  touchChat(chatId);
  if (loadedChats.has(chatId)) return;
  loadedChats.add(chatId);
  try {
    const messages = await api.chats.messages(chatId, { limit: TRANSCRIPT_PAGE_SIZE });
    // A FULL page means the window is capped, so assume there's more above; a
    // short page proves we already hold the whole transcript.
    useMessages
      .getState()
      .setForChat(chatId, messages, { hasMore: messages.length >= TRANSCRIPT_PAGE_SIZE });
    // The snapshot never contains a still-open permission card, so re-open of a
    // chat blocked on one has to put it back explicitly.
    void restorePendingPermissions(chatId);
    const checkpoints = await api.chats.checkpoints(chatId).catch(() => []);
    useCheckpoints.getState().hydrate(chatId, checkpoints.map((c) => c.messageId));
  } catch {
    loadedChats.delete(chatId); // allow a retry on the next open
  }
}

/**
 * Page in the rows ABOVE the current window (the user scrolled to the top of the
 * transcript). No-op when there's nothing older or a page is already in flight.
 */
export async function loadOlderMessages(chatId: string): Promise<void> {
  const store = useMessages.getState();
  const page = store.pages[chatId];
  if (!page?.hasMore || page.loadingOlder) return;
  const oldest = store.byChat[chatId]?.[0];
  if (!oldest) return;

  store.setPage(chatId, { loadingOlder: true });
  try {
    const older = await api.chats.messages(chatId, {
      limit: TRANSCRIPT_PAGE_SIZE,
      beforeId: oldest.id,
    });
    useMessages.getState().prependForChat(chatId, older, {
      hasMore: older.length >= TRANSCRIPT_PAGE_SIZE,
      loadingOlder: false,
    });
  } catch {
    // Keep `hasMore` so the sentinel can retry on the next scroll.
    useMessages.getState().setPage(chatId, { loadingOlder: false });
  }
}

/**
 * Fetch the verbatim rows behind lean (clipped) ones — the transcript ships tool
 * payloads as previews, and expanding a card needs the real thing. Best-effort:
 * on failure the card keeps showing its preview.
 */
export async function hydrateFullRows(chatId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await api.chats.messagesFull(chatId, ids);
    useMessages.getState().replaceRows(chatId, rows);
  } catch {
    /* the preview stays; expanding again retries */
  }
}

/** Load the right-panel views (worktrees, PRs, Actions) for a project. */
export async function loadProjectPanels(projectId: string): Promise<void> {
  const worktrees: WorktreeInfo[] = await api.worktrees
    .list(projectId)
    .catch(() => []);
  const prs: PRInfo[] = await api.github
    .prs(projectId, { state: "all", limit: 40 })
    .catch(() => []);
  const workflowRuns: WorkflowRun[] = await api.github
    .runs(projectId, { limit: 20 })
    .catch(() => []);
  usePanels.getState().hydrate({
    worktrees,
    diffs: usePanels.getState().diffs,
    prs,
    workflowRuns,
  });
  void loadProjectMemory(projectId);
}

/** Fetch a project's durable agent memory into the store (Memory panel spine). */
export async function loadProjectMemory(projectId: string): Promise<void> {
  try {
    const memories = await api.memory.list(projectId);
    useMemory.getState().setForProject(projectId, memories);
  } catch {
    /* a failed fetch just leaves the panel empty until the next attempt */
  }
}

/** Fetch + cache a worktree's diff-vs-base summary (stat line for the panel). */
export async function loadWorktreeDiff(
  worktreePath: string,
  base = "main",
): Promise<void> {
  try {
    const d = await api.worktrees.diff(worktreePath, base);
    usePanels.getState().setDiff(worktreePath, {
      additions: d.additions,
      deletions: d.deletions,
      files: d.files.map((f) => ({
        path: f.path,
        add: f.additions,
        del: f.deletions,
      })),
    });
  } catch {
    /* a git failure just means no diff summary for this worktree */
  }
}

let liveDisposers: (() => void)[] = [];

/**
 * Wire the data spine's reactive loads: when the active chat changes, lazy-load
 * its transcript; when the active project changes, refresh its panels. Idempotent
 * (restarts cleanly). Call once at boot; `ws.connect()` drives the actual hydrate
 * via the `hello` event.
 */
export function startLiveData(): void {
  stopLiveData();
  let lastChat = useChats.getState().activeChatId;
  liveDisposers.push(
    useChats.subscribe((s) => {
      // Track the CLEARED state too (a project switch closes the open chat):
      // otherwise `lastChat` stays pinned to the chat we just closed, and
      // re-opening it doesn't re-fetch a transcript the LRU may have evicted.
      if (s.activeChatId !== lastChat) {
        lastChat = s.activeChatId;
        if (s.activeChatId) void ensureChatMessages(s.activeChatId);
      }
    }),
  );
  let lastProject = useProjects.getState().activeProjectId;
  liveDisposers.push(
    useProjects.subscribe((s) => {
      if (s.activeProjectId && s.activeProjectId !== lastProject) {
        lastProject = s.activeProjectId;
        void loadProjectPanels(s.activeProjectId);
      }
    }),
  );
}

/** Tear down the live-data subscriptions. */
export function stopLiveData(): void {
  for (const d of liveDisposers) d();
  liveDisposers = [];
}
