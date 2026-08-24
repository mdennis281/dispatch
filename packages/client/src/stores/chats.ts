import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  Chat,
  ChatStatus,
  AgentActivity,
  PrRecord,
  WorkflowExemption,
} from "@dispatch/shared";
import { isPrSettledIdle } from "@dispatch/shared";
import { clearDraft } from "../lib/composerDrafts.js";
import { usePrs } from "./prs.js";

interface ChatsStore {
  /** chatId → Chat */
  byId: Record<string, Chat>;
  /** display order (most-recent activity first is applied at hydrate time) */
  order: string[];
  activeChatId: string | null;
  /** derived live activity per chat (from chat-status events) */
  activity: Record<string, AgentActivity | undefined>;
  /** steering messages submitted but not yet consumed, per chat (server truth) */
  queued: Record<string, number>;
  /**
   * chatId → a `watch_pr` on this chat reached a terminal PR state (merged/closed)
   * and hasn't been superseded by a new message. Combined with an `idle` status it
   * renders the sidebar dot green ("PR done") instead of the neutral idle gray.
   */
  prSettled: Record<string, boolean>;
  /**
   * chatId → the human-approved guard lifts live on that chat's session.
   *
   * Server-authoritative and always the FULL list: a `chat-exemptions` event
   * replaces the entry wholesale, and a reconnect clears the map rather than
   * carrying claims we can no longer verify. A chip that says a guard is lifted
   * when it isn't is worse than no chip at all — the whole point of it is that
   * you can trust what it says at a glance.
   */
  exemptions: Record<string, WorkflowExemption[]>;
  /**
   * chatId → epoch-ms of last observed activity (message/chunk/status/update).
   * Drives the sidebar's recency order + its "age" label. Seeded from the
   * server's `updatedAt`/`createdAt` at hydrate, then advanced by live events —
   * so a chat floats to the top the instant it starts streaming.
   *
   * Advanced only by events that mean the CHAT did something (see
   * `statusIsActivity`). A status arriving because its session was torn down is
   * not the chat doing something, and this clock is client-only — the server's
   * `updatedAt` deliberately survives a status write, so nothing here would ever
   * put a wrongly-bumped age back.
   */
  lastActivity: Record<string, number>;

  /**
   * Open a chat, or `null` for "nothing open" (the empty state).
   *
   * Prefer {@link selectChat} / {@link selectProject} from `stores/navigation.ts`
   * over calling this directly: a chat is only ever viewable inside its OWN
   * project, and those keep the two selections in step.
   */
  setActiveChat: (id: string | null) => void;
  hydrate: (chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
  /** Advance a chat's last-activity clock (coalesced so bursty chunks don't churn). */
  bumpActivity: (chatId: string, ts?: number) => void;
  /** Drop a deleted chat; if it was active, reselect a sibling (same project first). */
  removeChat: (chatId: string) => void;
  setStatus: (
    chatId: string,
    status: ChatStatus,
    activity?: AgentActivity,
    queued?: number,
    prSettled?: boolean,
  ) => void;
  setExemptions: (chatId: string, exemptions: WorkflowExemption[]) => void;
}

export const useChats = create<ChatsStore>((set) => ({
  byId: {},
  order: [],
  activeChatId: null,
  activity: {},
  queued: {},
  prSettled: {},
  exemptions: {},
  lastActivity: {},

  setActiveChat: (id) => set({ activeChatId: id }),

  hydrate: (chats) =>
    set((s) => {
      const byId: Record<string, Chat> = {};
      const lastActivity: Record<string, number> = {};
      const prSettled: Record<string, boolean> = {};
      for (const c of chats) {
        byId[c.id] = c;
        lastActivity[c.id] = c.updatedAt ?? c.createdAt;
        // Rebuilt from the record on every load. `prSettled` is otherwise only
        // ever written by a live `chat-status` event, so a reload turned every
        // chat that had already landed its PR back into an anonymous gray "idle".
        if (isPrSettledIdle(c)) prSettled[c.id] = true;
      }
      const order = [...chats]
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .map((c) => c.id);
      // Keep whatever the reader has OPEN. Taking `order[0]` unconditionally
      // meant a reconnect handed the view to whichever chat happened to hold the
      // newest `updatedAt` — a worktree reconcile on an unrelated chat is enough
      // to move that — and if it lived in another project, `visibleChat` went
      // undefined and unmounted the transcript outright before the caller could
      // put the selection back.
      const activeChatId =
        s.activeChatId && byId[s.activeChatId] ? s.activeChatId : (order[0] ?? null);
      // Deliberately dropped, not carried: a reconnect means the sessions that
      // held these may not exist any more (an exemption dies with its session),
      // and `loadExemptions` re-reads the open chat's straight afterwards.
      return { byId, order, lastActivity, prSettled, exemptions: {}, activeChatId };
    }),

  upsertChat: (chat) =>
    set((s) => ({
      byId: { ...s.byId, [chat.id]: chat },
      order: s.order.includes(chat.id) ? s.order : [chat.id, ...s.order],
      // A `chat-update` is how the settled PR ref reaches the client, so re-derive
      // here too rather than waiting for the next status event to carry the flag.
      prSettled: { ...s.prSettled, [chat.id]: isPrSettledIdle(chat) },
      lastActivity: {
        ...s.lastActivity,
        [chat.id]: Math.max(
          s.lastActivity[chat.id] ?? 0,
          chat.updatedAt ?? chat.createdAt,
        ),
      },
    })),

  bumpActivity: (chatId, ts) =>
    set((s) => {
      const now = ts ?? Date.now();
      const prev = s.lastActivity[chatId] ?? 0;
      // Coalesce bursty chunk activity into ~1 update/sec so streaming doesn't
      // thrash the sidebar's recency sort.
      if (now - prev < 750) return {};
      return { lastActivity: { ...s.lastActivity, [chatId]: Math.max(prev, now) } };
    }),

  removeChat: (chatId) => {
    // The chat's assets are gone with it, so its saved composer draft (which
    // references them) has to go too — otherwise it lingers in localStorage
    // until the age sweep.
    clearDraft(chatId);
    set((s) => {
      if (!s.byId[chatId]) return {};
      const removed = s.byId[chatId];
      const byId = { ...s.byId };
      delete byId[chatId];
      const activity = { ...s.activity };
      delete activity[chatId];
      const queued = { ...s.queued };
      delete queued[chatId];
      const prSettled = { ...s.prSettled };
      delete prSettled[chatId];
      const exemptions = { ...s.exemptions };
      delete exemptions[chatId];
      const lastActivity = { ...s.lastActivity };
      delete lastActivity[chatId];
      const order = s.order.filter((id) => id !== chatId);
      // Keep a selection alive, but only WITHIN the deleted chat's project —
      // falling through to any remaining chat used to open one from a project
      // the user isn't looking at. Nothing left in it → the empty state.
      const activeChatId =
        s.activeChatId === chatId
          ? (order.find((id) => byId[id]?.projectId === removed.projectId) ?? null)
          : s.activeChatId;
      return { byId, order, activity, queued, prSettled, exemptions, lastActivity, activeChatId };
    });
  },

  setStatus: (chatId, status, activity, queued, prSettled) =>
    set((s) => ({
      byId: s.byId[chatId]
        ? { ...s.byId, [chatId]: { ...s.byId[chatId]!, status } }
        : s.byId,
      activity: { ...s.activity, [chatId]: activity },
      queued: { ...s.queued, [chatId]: queued ?? 0 },
      prSettled: { ...s.prSettled, [chatId]: prSettled ?? false },
    })),

  setExemptions: (chatId, exemptions) =>
    set((s) => ({ exemptions: { ...s.exemptions, [chatId]: exemptions } })),
}));

/**
 * Chats belonging to a project, most-recent activity first. `null` means "no
 * project in focus", which yields every chat (the picker-less case) — pass a
 * real id to get a project-scoped list.
 *
 * Pure so the sidebar selector and the navigation invariants share one
 * definition of "this project's chats, newest first".
 */
export function chatsForProject(
  s: Pick<ChatsStore, "order" | "byId" | "lastActivity">,
  projectId: string | null,
): Chat[] {
  const at = (c: Chat) => s.lastActivity[c.id] ?? c.updatedAt ?? c.createdAt;
  return s.order
    // No `!` here: `order` legitimately outruns `byId` for an instant during a
    // removal, and the type guard below is what drops those — asserting them
    // away would just hide the next real one.
    .map((id): Chat | undefined => s.byId[id])
    .filter((c): c is Chat => !!c && (!projectId || c.projectId === projectId))
    .sort((a, b) => at(b) - at(a));
}

/** Selector: chats for a project, ordered by most-recent activity first. */
export function useProjectChats(projectId: string | null): Chat[] {
  return useChats(useShallow((s) => chatsForProject(s, projectId)));
}

/**
 * The pull request a reviewer chat was pointed at, as a `PrRecord` key.
 *
 * `reviewOf` is the record. The label parse behind it covers the reviewers
 * spawned BEFORE that field existed, whose only trace of their target is the
 * sentence `taskLabel` (server `agent-tasks.ts`) wrote for the sidebar. Dropping
 * it would strand every review already on disk at the top level — which is the
 * clutter the nesting exists to clear, so on the machine that asked for this the
 * feature would have looked like it did nothing.
 */
export function reviewTargetKey(chat: Chat): string | null {
  if (chat.reviewOf) return chat.reviewOf;
  if (chat.purpose?.kind !== "pr:review") return null;
  const m = /^Reviewing PR #(\d+) in (\S+)$/.exec(chat.purpose.label ?? "");
  return m ? `${m[2]}#${m[1]}` : null;
}

/**
 * Whether this chat is a PR reviewer, which is NOT the same question as whether
 * {@link reviewTargetKey} can name its pull request.
 *
 * A reviewer too old to carry `reviewOf`, whose `purpose.label` no longer
 * parses, is still a reviewer — it just cannot say of what. Splitting a branch's
 * children on the key instead would file that chat with the spawned ones and
 * count it as a plain chat, quietly turning "1 unattributed" (which admits what
 * it doesn't know) into a wrong answer stated confidently.
 */
export function isReviewerChat(chat: Chat): boolean {
  return chat.reviewOf != null || chat.purpose?.kind === "pr:review";
}

/**
 * The chat that spawned this one, when another chat did (`spawn_chat`).
 *
 * `parentChatId` is the record. The label parse behind it covers the chats
 * spawned BEFORE that field existed, whose only trace of their parent is the
 * sentence `container.ts` wrote into `purpose.label` — the same legacy shape,
 * and there for the same reason, as {@link reviewTargetKey}'s: without it every
 * chat already on disk stays stranded at the top level, which is exactly the
 * clutter the nesting exists to clear.
 *
 * Null for a chat a human opened, and for one spawned with `detached: true` —
 * that flag's whole effect is declining to write the field.
 */
export function spawnParentId(chat: Chat): string | null {
  if (chat.parentChatId) return chat.parentChatId;
  if (chat.purpose?.kind !== "spawned") return null;
  const m = /^Spawned by chat (\S+)$/.exec(chat.purpose.label ?? "");
  return m?.[1] ?? null;
}

/**
 * The chat a row files under by EITHER route, or null when it files under none.
 *
 * A reviewer joins its parent THROUGH the pull request rather than by a direct
 * id, because it is spawned by the PR registry and not by the chat that opened
 * the change — there is no moment at which one chat asks for the other. A
 * spawned chat has that moment, so it carries the id.
 */
function parentOf(chat: Chat, prsByKey: Record<string, PrRecord>): string | null {
  const key = reviewTargetKey(chat);
  if (key) return prsByKey[key]?.chatId ?? null;
  return spawnParentId(chat);
}

/**
 * The TOP-LEVEL chat a row files under, or null when the row is top-level itself.
 *
 * Walks the chain rather than reading one link, because a child can spawn a
 * child: `spawn_chat` is offered to every chat, including one that is already
 * folded. Nesting stays ONE level — a tree that can nest arbitrarily is a tree
 * somebody has to indent-guard — so a grandchild files under its GRANDPARENT,
 * beside its own parent, rather than under a row that is itself hidden inside
 * another. Filed under a hidden row it would render nowhere at all.
 *
 * A parent that isn't here (deleted, living in another project, an unattributed
 * PR) ends the walk and the row keeps the position it had. Nesting hides a row
 * inside another row, and hiding one inside a row that doesn't exist would just
 * delete it from the sidebar.
 *
 * A cycle returns null for every chat in it. Two chats that each claim the other
 * are both children and therefore both hidden, so the sidebar would lose the
 * pair entirely; top-level is the reading that still shows them. Only reachable
 * from corrupt data, but it is the failure mode with no visible symptom.
 */
function topParentOf(
  chat: Chat,
  byId: Map<string, Chat>,
  present: ReadonlySet<string>,
  prsByKey: Record<string, PrRecord>,
): string | null {
  const seen = new Set<string>([chat.id]);
  let cursor = chat;
  let top: string | null = null;
  for (;;) {
    const parent = parentOf(cursor, prsByKey);
    if (!parent || !present.has(parent)) return top;
    if (seen.has(parent)) return null;
    seen.add(parent);
    top = parent;
    const next = byId.get(parent);
    if (!next) return top;
    cursor = next;
  }
}

/** A top-level chat plus the chats filed under it. */
export interface ChatBranch {
  chat: Chat;
  /**
   * This chat's reviewers and the chats it spawned, newest first. Usually empty.
   *
   * One list rather than one per kind: the row treats them alike for everything
   * structural — the fold, the process census, the runtime roll-up, the reap —
   * and only the child row itself cares which it is, because a reviewer has a
   * pull request to summarise and a spawned chat has only its title.
   */
  children: Chat[];
}

/**
 * Fold a flat chat list into one level of nesting: a reviewer moves under the
 * chat that opened the PR it is reading, and a spawned chat under the chat that
 * spawned it.
 *
 * A branch ranks by the NEWEST clock in it, its own or a child's. Without that,
 * a review that starts on a week-old chat sinks to wherever its parent sits and
 * the one row that is actually doing something is off the bottom of the list.
 */
export function buildChatTree(
  chats: Chat[],
  lastActivity: Record<string, number>,
  prsByKey: Record<string, PrRecord>,
): ChatBranch[] {
  const at = (c: Chat) => lastActivity[c.id] ?? c.updatedAt ?? c.createdAt;
  const present = new Set(chats.map((c) => c.id));
  const byId = new Map(chats.map((c) => [c.id, c]));
  const children = new Map<string, Chat[]>();
  const roots: Chat[] = [];

  for (const chat of chats) {
    const parent = topParentOf(chat, byId, present, prsByKey);
    if (parent && parent !== chat.id) {
      const list = children.get(parent);
      if (list) list.push(chat);
      else children.set(parent, [chat]);
    } else {
      roots.push(chat);
    }
  }

  return roots
    .map((chat) => ({ chat, children: children.get(chat.id) ?? [] }))
    .sort((a, b) => rankBranch(b, at) - rankBranch(a, at));
}

const rankBranch = (b: ChatBranch, at: (c: Chat) => number): number =>
  b.children.reduce((max, r) => Math.max(max, at(r)), at(b.chat));

/**
 * Selector: this project's chats as branches, newest first.
 *
 * Built in a `useMemo` over three STABLE store references rather than inside a
 * zustand selector. `useShallow` compares elements by identity and a branch is a
 * fresh object every call, so as a selector this would hand
 * `useSyncExternalStore` a new snapshot on every check and never converge — the
 * `Minified React error #185` that `stores/prs.ts` documents at length.
 */
export function useProjectChatTree(projectId: string | null): ChatBranch[] {
  const chats = useProjectChats(projectId);
  const lastActivity = useChats((s) => s.lastActivity);
  const prsByKey = usePrs((s) => s.byKey);
  return useMemo(
    () => buildChatTree(chats, lastActivity, prsByKey),
    [chats, lastActivity, prsByKey],
  );
}

/**
 * Statuses that mean an agent is mid-turn on this chat. `queued` counts: the
 * turn is already submitted and will run on its own, so the project has work in
 * flight even though nothing is streaming yet.
 */
const WORKING_STATUS: ReadonlySet<ChatStatus> = new Set(["running", "waiting", "queued"]);

/**
 * Whether an agent is mid-turn on this chat — the project picker's badge and
 * the row's child-chat glyph asking the same question of one definition.
 *
 * Exported rather than re-spelled at the call site because the narrow reading
 * (`status === "running"`) is the tempting one and it is wrong in the case that
 * matters most: `waiting` is what the broker assigns for a tool blocked on work
 * elsewhere, which is a `watch_pr` sitting on a PR for ten minutes. A marker
 * that goes quiet for exactly those ten minutes is quiet when you need it.
 */
export function isChatWorking(status: ChatStatus | undefined): boolean {
  return status != null && WORKING_STATUS.has(status);
}

/**
 * Statuses whose arrival counts as the CHAT doing something, for `lastActivity`.
 *
 * `idle` and `done` are excluded because they are the two the broker also emits
 * for reasons that have nothing to do with the chat: `broker.stop()` settles a
 * session to `done`/`idle`, and it is called by the Power button, the idle
 * sweep, `setHarness` and dispose alike. Reaping a chat's processes was
 * therefore resetting its age to "now" and floating it to the top of the
 * sidebar — for a whole BRANCH at once, since the button reaps the reviewers
 * too — and the idle sweep was quietly doing the same to every parked chat on
 * its own timer.
 *
 * Nothing is lost at a real turn end: the `chat-message` that ends the turn
 * bumps the clock a beat before the `done` does, with the message's own
 * timestamp. What we keep is the other direction — `error`/`failed` and
 * `awaiting-input` ARE news even with no message behind them, and a chat that
 * has just blocked on a question must not sink while it waits for you.
 */
const ACTIVITY_STATUS: ReadonlySet<ChatStatus> = new Set([
  "queued",
  "running",
  "waiting",
  "awaiting-input",
  "failed",
  "error",
]);

/** Whether a `chat-status` event should advance the row's activity clock. */
export function statusIsActivity(status: ChatStatus): boolean {
  return ACTIVITY_STATUS.has(status);
}

export interface ProjectAgentCounts {
  /** Chats with an agent mid-turn. */
  working: number;
  /** Chats stopped on a question — nothing moves until a human answers. */
  attention: number;
}

/**
 * projectId → live agent counts. Pure so the picker's badge and its test share
 * one definition of "an agent is live in this project".
 */
export function countProjectAgents(byId: Record<string, Chat>): Record<string, ProjectAgentCounts> {
  const out: Record<string, ProjectAgentCounts> = {};
  for (const id in byId) {
    const chat = byId[id]!;
    const status = chat.status;
    if (chat.archived || !status) continue;
    if (status !== "awaiting-input" && !WORKING_STATUS.has(status)) continue;
    const counts = (out[chat.projectId] ??= { working: 0, attention: 0 });
    if (status === "awaiting-input") counts.attention++;
    else counts.working++;
  }
  return out;
}

/**
 * Selector: live agent counts per project, for the project picker's right-hand
 * hint.
 *
 * Subscribes to `byId` (a flat record, so `useShallow` genuinely compares it)
 * and derives OUTSIDE the selector. Building the nested result inside the
 * selector would hand zustand a new object on every read, which is the render
 * loop that white-screened the app once already — see the PR selector.
 */
export function useProjectAgentCounts(): Record<string, ProjectAgentCounts> {
  const byId = useChats(useShallow((s) => s.byId));
  return useMemo(() => countProjectAgents(byId), [byId]);
}
