/**
 * Which artifact the pane beside the chat is showing, and the newest version of
 * each artifact the transcript has mentioned.
 *
 * `latest` is fed by two sources that agree by construction: the transcript
 * CARDS (every `artifact_update` lands as a tool result the card parses) and
 * the server's `artifact-updated` event. The cards alone left a pane stale
 * whenever the card wasn't rendered — scrolled out of the window, folded into a
 * collapsed group. `noteLatest` only ever moves forward, so the two arriving in
 * either order is harmless. A pane following "latest" re-resolves when the
 * number moves — an agent iterating on a page is watched live.
 *
 * Not persisted: an artifact pane that reopens itself after a reload, over a
 * chat you have since navigated away from, is a sheet nobody asked for.
 *
 * `popped` is which artifacts are live in a window of their own right now
 * (lib/artifactWindow keeps it current over a BroadcastChannel). The pane
 * shows a placeholder for those instead of a second live view.
 */
import { create } from "zustand";

export interface OpenArtifact {
  chatId: string;
  id: string;
  /** A pinned version, or null to follow the newest. */
  version: number | null;
}

export interface PoppedArtifact {
  /** As the window last reported it — the placeholder names what is out. */
  title?: string;
  version?: number;
}

interface ArtifactViewStore {
  open: OpenArtifact | null;
  /** Fills the main area instead of sharing it with the transcript. */
  expanded: boolean;
  /** `${chatId}:${id}` → newest version the transcript has shown. */
  latest: Record<string, number>;
  /** `${chatId}:${id}` → an artifact currently popped out into its own window. */
  popped: Record<string, PoppedArtifact>;
  openArtifact: (chatId: string, id: string, version?: number | null) => void;
  close: () => void;
  setExpanded: (expanded: boolean) => void;
  noteLatest: (chatId: string, id: string, version: number) => void;
  markPopped: (chatId: string, id: string, info: PoppedArtifact) => void;
  unmarkPopped: (chatId: string, id: string) => void;
}

export const artifactKey = (chatId: string, id: string) => `${chatId}:${id}`;

export const useArtifactView = create<ArtifactViewStore>((set, get) => ({
  open: null,
  expanded: false,
  latest: {},
  popped: {},
  openArtifact: (chatId, id, version = null) => set({ open: { chatId, id, version } }),
  close: () => set({ open: null, expanded: false }),
  setExpanded: (expanded) => set({ expanded }),
  noteLatest: (chatId, id, version) => {
    const key = artifactKey(chatId, id);
    if ((get().latest[key] ?? 0) >= version) return;
    set((s) => ({ latest: { ...s.latest, [key]: version } }));
  },
  markPopped: (chatId, id, info) => {
    const key = artifactKey(chatId, id);
    // Merge: the window's first `present` can arrive before it knows the
    // title, and must not erase the one the pane passed when it opened it.
    set((s) => ({ popped: { ...s.popped, [key]: { ...s.popped[key], ...info } } }));
  },
  unmarkPopped: (chatId, id) => {
    const key = artifactKey(chatId, id);
    if (!(key in get().popped)) return;
    set((s) => {
      const { [key]: _gone, ...rest } = s.popped;
      return { popped: rest };
    });
  },
}));
