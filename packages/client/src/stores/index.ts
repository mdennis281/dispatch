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
import type { WsServerEvent, WorktreeInfo, PRInfo, WorkflowRun } from "@cm/shared";

import { api } from "../lib/api.js";
import { useConnection } from "./connection.js";
import { useProjects } from "./projects.js";
import { useChats } from "./chats.js";
import { useMessages } from "./messages.js";
import { useAttention } from "./attention.js";
import { useRunners } from "./runners.js";
import { useTerminals } from "./terminals.js";
import { usePanels } from "./panels.js";
import { useMemory } from "./memory.js";
import { useMcp } from "./mcp.js";
import { useCheckpoints } from "./checkpoints.js";
import { useNotices } from "./notices.js";

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
export { useMessages, useChatMessages } from "./messages.js";
export { useAttention, useAttentionCount } from "./attention.js";
export { useRunners, useChatRunners } from "./runners.js";
export { useTerminals, useChatTerminals } from "./terminals.js";
export { usePanels } from "./panels.js";
export { useMemory, useProjectMemories } from "./memory.js";
export { useCheckpoints, useHasCheckpoint } from "./checkpoints.js";
export { useNotices } from "./notices.js";
export type { Toast, NoticeLevel } from "./notices.js";

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
 * The one reducer: apply a server event to the stores. Exhaustive over
 * WsServerEvent so a new event type is a compile error until it's handled.
 */
export function applyServerEvent(evt: WsServerEvent): void {
  switch (evt.type) {
    case "hello":
      useConnection.getState().onHello(evt.serverTime);
      // (Re)hydrate the authoritative REST snapshot on every connect — the very
      // first one primes the app; a reconnect resyncs after a server restart.
      void hydrateFromServer();
      return;

    case "chat-message":
      useMessages.getState().append(evt.chatId, evt.message);
      return;

    case "message-chunk":
      useMessages.getState().chunk(evt.chatId, evt.messageId, evt.delta, evt.channel);
      return;

    case "chat-status":
      useChats.getState().setStatus(evt.chatId, evt.status, evt.activity);
      // A turn that leaves the running/awaiting state (idle turn-end, session
      // done, or error) has no in-flight assistant stream: clear any lingering
      // streaming buffers so an interrupted/aborted message's partial text can't
      // leave a stuck StreamingRow (perpetual ●●●) that resurfaces next turn.
      if (evt.status === "idle" || evt.status === "done" || evt.status === "error") {
        useMessages.getState().clearStreaming(evt.chatId);
      }
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

    case "attention-add":
      useAttention.getState().add(evt.item);
      return;

    case "attention-resolve":
      useAttention.getState().resolve(evt.id);
      return;

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
      useAttention.getState().clearChat(evt.chatId);
      useChats.getState().removeChat(evt.chatId);
      return;

    case "project-update":
      useProjects.getState().upsertProject(evt.project);
      return;

    case "project-config-update":
      // A managed repo's `.claude-manager/` config was (re)loaded. Phase 1 only
      // syncs the store (a `project-update` follows when authored fields change);
      // a later phase renders the config/errors panel from this event.
      return;

    case "memory-update":
      // A memory was created/updated (agent `remember` or a panel edit) — upsert
      // it so the Memory panel live-updates without a refetch.
      useMemory.getState().upsert(evt.memory);
      return;

    case "memory-deleted":
      useMemory.getState().remove(evt.projectId, evt.name);
      return;

    case "notice":
      useNotices.getState().push({
        level: evt.level,
        text: evt.text,
        chatId: evt.chatId,
      });
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

/**
 * REST-hydrate the authoritative snapshot into every store. Config lists always
 * load; the per-project/per-chat deep views (worktrees, PRs, Actions, transcript)
 * load best-effort so a slow/failed `git`/`gh` never blocks the app. Preserves
 * the user's active project/chat across a reconnect. Returns false only when the
 * core lists are unreachable (backend down) — the caller then keeps the mock.
 */
export async function hydrateFromServer(): Promise<boolean> {
  let projects, agents, modes, chats, attention, runners, terminals;
  try {
    [projects, agents, modes, chats, attention, runners, terminals] = await Promise.all([
      api.projects.list(),
      api.agents.list(),
      api.modes.list(),
      api.chats.list(),
      api.attention.list(),
      api.runners.list(),
      api.terminals.list().catch(() => []),
    ]);
  } catch {
    return false;
  }

  const prevProject = useProjects.getState().activeProjectId;
  const prevChat = useChats.getState().activeChatId;

  loadedChats.clear();
  useProjects.getState().hydrate({ projects, agents, modes });
  useChats.getState().hydrate(chats);
  useAttention.getState().hydrate(attention);
  useRunners.getState().hydrate(runners, {});
  useTerminals.getState().hydrate(terminals, {});
  useMessages.getState().hydrate({});
  useCheckpoints.getState().reset();
  useMemory.getState().reset();
  useMcp.getState().reset();
  usePanels.getState().hydrate({ worktrees: [], diffs: {}, prs: [], workflowRuns: [] });

  // Keep the user where they were after a reconnect.
  if (prevProject && projects.some((p) => p.id === prevProject)) {
    useProjects.getState().setActiveProject(prevProject);
  }
  if (prevChat && chats.some((c) => c.id === prevChat)) {
    useChats.getState().setActiveChat(prevChat);
  }

  const activeProject = useProjects.getState().activeProjectId;
  if (activeProject) void loadProjectPanels(activeProject);
  const activeChat = useChats.getState().activeChatId;
  if (activeChat) void ensureChatMessages(activeChat);

  // Re-materialize open permission/question cards. They're synthesized from the
  // transient `permission-request` event and only persisted on resolution, so
  // the transcript wipe above drops them; without this a reconnect mid-tool
  // leaves an attention badge whose inline card is gone and the tool blocked.
  // `upsertPermissionRequest` is idempotent and `setForChat` carries these
  // (absent-from-snapshot) rows, so it's safe regardless of load ordering.
  void api.attention
    .pendingPermissions()
    .then((reqs) => {
      for (const r of reqs) useMessages.getState().upsertPermissionRequest(r.chatId, r);
    })
    .catch(() => {
      /* best-effort — a failed snapshot just means no re-materialized cards */
    });

  return true;
}

/** Lazily fetch a chat's transcript + rollback anchors (once per session). */
export async function ensureChatMessages(chatId: string): Promise<void> {
  if (loadedChats.has(chatId)) return;
  loadedChats.add(chatId);
  try {
    const messages = await api.chats.messages(chatId);
    useMessages.getState().setForChat(chatId, messages);
    const checkpoints = await api.chats.checkpoints(chatId).catch(() => []);
    useCheckpoints.getState().hydrate(chatId, checkpoints.map((c) => c.messageId));
  } catch {
    loadedChats.delete(chatId); // allow a retry on the next open
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
      if (s.activeChatId && s.activeChatId !== lastChat) {
        lastChat = s.activeChatId;
        void ensureChatMessages(s.activeChatId);
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
