/**
 * Project ↔ chat selection, kept in step.
 *
 * The invariant this module exists to hold: **the open chat always belongs to
 * the focused project.** Selection used to be two independent `set()` calls in
 * two stores, and every caller had to remember to do both. Most didn't — so
 * clicking an Attention item for another project's chat rendered that chat
 * beside the WRONG project's sidebar, panels and Source Control, and switching
 * projects left the previous project's transcript sitting in the main area with
 * nothing highlighted in the rail beside it.
 *
 * Route selection through these three functions instead of poking
 * `setActiveProject` / `setActiveChat` directly:
 *   - {@link selectProject} — switch focus; the open chat goes with it.
 *   - {@link selectChat}    — open a chat, bringing its project along.
 *   - {@link reconcileActiveChat} — re-establish the invariant after a hydrate.
 *
 * These live outside the stores because the rule spans two of them, and neither
 * store should have to import the other.
 */
import { GLOBAL_PROJECT_ID } from "@dispatch/shared";
import type { Chat } from "@dispatch/shared";
import { useChats, chatsForProject } from "./chats.js";
import { useProjects } from "./projects.js";
import { useView } from "./view.js";
import { useLayout } from "./layout.js";

/**
 * Focus a project. Switching AWAY closes the open chat: it belongs to the
 * project you just left, so the main area falls back to the empty state and the
 * user picks from the (now correct) sidebar. Re-selecting the project already in
 * focus is a no-op — `ManageConfigDialog` re-sets it to force a config reload,
 * and that must not throw away what you were reading.
 */
export function selectProject(projectId: string): void {
  const projects = useProjects.getState();
  if (projects.activeProjectId === projectId) return;
  projects.setActiveProject(projectId);
  useChats.getState().setActiveChat(null);
}

/**
 * Open a chat, switching to its project first when it lives in another one —
 * the Attention Queue, the command palette and desktop-notification clicks are
 * all cross-project entry points.
 *
 * Also snaps back to the chat surface: opening a chat while the Memory or
 * Source Control view fills the main area otherwise looks like nothing happened.
 *
 * A chat the store hasn't seen yet is still selected. The `#chat=` deep link
 * fires on a timer that can beat hydrate, and the id becoming real a moment
 * later is the normal case; until then the main area shows the empty state.
 */
export function selectChat(chatId: string): void {
  const chat = useChats.getState().byId[chatId];
  if (chat) {
    const projects = useProjects.getState();
    if (chat.projectId !== projects.activeProjectId) projects.setActiveProject(chat.projectId);
  }
  useChats.getState().setActiveChat(chatId);
  useView.getState().setView("chat");
}

/**
 * Open the GLOBAL chat surface — the reserved pseudo-project.
 *
 * Deliberately built out of the two functions above rather than setting the
 * two selections itself. The global chat is special in what it is ALLOWED to
 * do, not in how it is navigated to: it is a project id like any other, so the
 * invariant this module holds applies to it unchanged, and an entry point that
 * poked `setActiveProject`/`setActiveChat` directly would be the one place
 * free to get it wrong.
 *
 * Lands on the most recent global chat when there is one, and on the empty
 * state when there isn't — `reconcileActiveChat` already encodes that choice
 * for a hydrate, and arriving at an empty surface when a conversation is
 * sitting right there is the same bad landing here.
 */
export function selectGlobalChat(): void {
  // Same reason `openProject` and `leaveHome` do it: at `sm` a Ship/Run pane
  // REPLACES the transcript, so a selection left over from wherever you were
  // renders full-width over the chat you just asked for. This is the shared
  // path — the sidebar's row, the command palette and the homepage's button
  // all land here — so resetting it once covers every entry point rather than
  // leaving the next one to remember.
  useLayout.getState().setPane("chat");
  selectProject(GLOBAL_PROJECT_ID);
  reconcileActiveChat();
  useView.getState().setView("chat");
}

/**
 * The chat the main area may actually render: the open one, but ONLY while it
 * belongs to the focused project.
 *
 * The functions above keep the two selections in step; this is what makes the
 * rule structural rather than a convention every future caller has to remember.
 * Everything beside the transcript — sidebar, right panel, Source Control — is
 * scoped to the active project, so a foreign chat here is a mixed-scope window.
 * An id the store hasn't seen (a deep link that beat hydrate) is likewise not
 * renderable yet.
 */
export function visibleChat(
  s: { activeChatId: string | null; byId: Record<string, Chat> },
  activeProjectId: string | null,
): Chat | undefined {
  const chat = s.activeChatId ? s.byId[s.activeChatId] : undefined;
  return chat && chat.projectId === activeProjectId ? chat : undefined;
}

/**
 * Re-establish the invariant after a hydrate, which sets the two selections from
 * two independent lists (the remembered-or-first project, and the
 * globally-most-recent chat) and so can land them in different projects.
 *
 * Unlike a project switch this prefers to KEEP a selection — a boot that opens
 * on the empty state when the project has chats is a worse landing than the
 * most recent one, which is what the un-scoped hydrate was reaching for anyway.
 */
export function reconcileActiveChat(): void {
  const chats = useChats.getState();
  const activeProjectId = useProjects.getState().activeProjectId;
  if (!activeProjectId) {
    // No project in focus (none exist yet) — nothing is legitimately open.
    if (chats.activeChatId !== null) chats.setActiveChat(null);
    return;
  }
  const active = chats.activeChatId ? chats.byId[chats.activeChatId] : undefined;
  if (active && active.projectId === activeProjectId) return;
  chats.setActiveChat(chatsForProject(chats, activeProjectId)[0]?.id ?? null);
}

/* ------------------------------------------------------------------- home */

/**
 * Where you were before you went home.
 *
 * THE HOMEPAGE MUST NOT BE A DEAD END, and it is full-bleed — there is no
 * sidebar beside it to climb back out through, so the control that brought you
 * there has to be the one that takes you back. That makes it a TOGGLE, and a
 * toggle needs somewhere to toggle back TO.
 *
 * The obvious source for that is the live selection, and it is the wrong one:
 * both `selectProject` and `selectChat` are invariant-preserving, so arriving
 * home with a chat open and then clicking a DIFFERENT project's card from the
 * grid has already moved the selection by the time the toggle is pressed. The
 * place is therefore snapshotted at the moment of leaving.
 *
 * Persisted in localStorage, on the same reasoning as `cm:last-project`
 * (stores/projects): where you are is a fact about this browser, not the
 * account. It also means arriving at a fresh tab ON the homepage — which is
 * what a reload mid-visit gives you — still has a way back rather than only the
 * grid.
 *
 * `chatId` can be null: you can be looking at the empty state, or at Memory, or
 * at Source Control, and all of those return to the project without a chat.
 */
const LAST_PLACE_KEY = "cm:home-return";

interface LastPlace {
  projectId: string | null;
  chatId: string | null;
}

/** Guarded, the house pattern — localStorage throws under a blocking cookie
 *  policy and does not exist at all in the node test environment. */
function placeBacking(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The return address, held in memory with localStorage as a CACHE of it rather
 * than as the record — the same relationship `stores/theme` has with its own key.
 *
 * In-memory is the source of truth because this value is read inside a click
 * handler and must be there whether or not storage is available: a blocking
 * cookie policy, private mode, or the node test environment all produce a
 * `null` backing, and in every one of those the toggle still has to work for the
 * length of the session.
 *
 * Shape-checked on the way in rather than trusted. The entry survives upgrades,
 * so a malformed one (hand-edited, written by an older build) must degrade to
 * "no return address" instead of throwing.
 */
let place: LastPlace = readPlace();

function readPlace(): LastPlace {
  const none: LastPlace = { projectId: null, chatId: null };
  try {
    const raw = placeBacking()?.getItem(LAST_PLACE_KEY);
    if (!raw) return none;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return none;
    const { projectId, chatId } = parsed as Partial<LastPlace>;
    return {
      projectId: typeof projectId === "string" ? projectId : null,
      chatId: typeof chatId === "string" ? chatId : null,
    };
  } catch {
    return none;
  }
}

function rememberPlace(next: LastPlace): void {
  place = next;
  try {
    placeBacking()?.setItem(LAST_PLACE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — a lost return address beats a thrown save */
  }
}

/** Where the toggle will take you back to. Exported for the tests and the tip. */
export function lastPlace(): LastPlace {
  return place;
}

/**
 * Go to the overview, snapshotting where you were so the toggle can return.
 *
 * Also closes the chat picker, because the overview is full-bleed and `App`
 * stops rendering the drawer entirely — leaving `leftOpen` set would mean
 * `currentSlot` reporting a visible picker that isn't on screen, so the first
 * Chats tap on a phone would spend itself clearing an invisible flag instead of
 * leaving. The flag is shell state, not a place, so it is cleared rather than
 * remembered.
 */
export function goHome(): void {
  if (useView.getState().view !== "home") {
    rememberPlace({
      projectId: useProjects.getState().activeProjectId,
      chatId: useChats.getState().activeChatId,
    });
  }
  useLayout.getState().setLeftOpen(false);
  useView.getState().setView("home");
}

/**
 * Leave the overview for wherever you came from.
 *
 * Three fallbacks, narrowest first, and the last one is what makes this
 * unconditionally safe: the remembered chat if it still exists, else the
 * remembered project, else the project already in focus. The view ends on
 * `chat` in every branch — including the one with no project at all, where it
 * lands on the empty state WITH the sidebar, which is a place you can navigate
 * from. The one thing this must never do is leave you on `home` after you asked
 * to leave.
 *
 * `pane` resets too, and that is not tidiness. Below `lg` the Ship/Run pane is
 * a sheet over the main area — at `sm` it IS the main area — so going home from
 * Run and pressing the control that says "Back to your chat" would put you back
 * on the Run panel with the transcript behind it. The view and the pane are two
 * axes over the same real estate (see BottomNav's `goView`, which resolves it
 * the same way), and a navigation that sets one and not the other is only ever
 * half a navigation.
 */
export function leaveHome(): void {
  const { projectId, chatId } = lastPlace();
  const chats = useChats.getState();
  useLayout.getState().setPane("chat");
  if (chatId && chats.byId[chatId]) {
    selectChat(chatId); // brings its project along, and sets the view itself
    return;
  }
  if (projectId && useProjects.getState().projects.some((p) => p.id === projectId)) {
    selectProject(projectId);
  }
  useView.getState().setView("chat");
}

/**
 * Enter a project from the overview's grid.
 *
 * Opens its most recent chat when it has one, rather than `selectProject`'s bare
 * focus-switch. The difference matters here and nowhere else: the sidebar's
 * picker leaves you looking at the rail you just used, so the empty state beside
 * it is a list to choose from — but the homepage UNMOUNTS on the way out, so the
 * same landing is an empty panel with a sidebar you have not seen yet. Picking a
 * project from a grid of them reads as "take me in", so it takes you in.
 *
 * Routed through `selectChat`/`selectProject` rather than setting either store
 * directly, which is this module's whole rule. The pane resets for the same
 * reason it does in {@link leaveHome}: at `sm` a stale Ship/Run selection would
 * render full-width over the chat you just picked.
 */
export function openProject(projectId: string): void {
  useLayout.getState().setPane("chat");
  const recent = chatsForProject(useChats.getState(), projectId)[0];
  if (recent) selectChat(recent.id);
  else {
    selectProject(projectId);
    useView.getState().setView("chat");
  }
}

/**
 * Open a chat FROM THE HOMEPAGE — `openProject`'s counterpart for the three
 * cross-project lists (chats, worktrees, pull requests).
 *
 * `selectChat` alone is not enough from here, for exactly the reason
 * `openProject` resets the pane: the homepage is full-bleed and is reached
 * from anywhere, so the Ship or Run pane you had open before you came is still
 * selected — and below `lg` that pane renders over (at `sm`, instead of) the
 * transcript. The row would have navigated correctly and looked like it had
 * done nothing.
 *
 * Not folded into `selectChat` itself: that is the invariant-keeping primitive
 * every cross-project entry point goes through (the attention queue, a
 * notification click, a deep link), and some of those are pressed from inside
 * a panel the reader means to keep.
 */
export function openChat(chatId: string): void {
  useLayout.getState().setPane("chat");
  selectChat(chatId);
}

/** The brand lockup and the project selector's Home row both press this. */
export function toggleHome(): void {
  if (useView.getState().view === "home") leaveHome();
  else goHome();
}
