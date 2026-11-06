/**
 * Which artifact the pane beside the chat is showing, and the newest version of
 * each artifact the transcript has mentioned.
 *
 * `latest` is fed by the transcript CARDS, not by a server event: every
 * `artifact_update` lands as a tool result the card already parses, so the card
 * is the one place that learns "v4 exists" at the moment it does. A pane
 * following "latest" refetches when that number moves — an agent iterating on a
 * page is watched live without a second channel that could disagree with the
 * transcript.
 *
 * Not persisted: an artifact pane that reopens itself after a reload, over a
 * chat you have since navigated away from, is a sheet nobody asked for.
 */
import { create } from "zustand";

export interface OpenArtifact {
  chatId: string;
  id: string;
  /** A pinned version, or null to follow the newest. */
  version: number | null;
}

interface ArtifactViewStore {
  open: OpenArtifact | null;
  /** Fills the main area instead of sharing it with the transcript. */
  expanded: boolean;
  /** `${chatId}:${id}` → newest version the transcript has shown. */
  latest: Record<string, number>;
  openArtifact: (chatId: string, id: string, version?: number | null) => void;
  close: () => void;
  setExpanded: (expanded: boolean) => void;
  noteLatest: (chatId: string, id: string, version: number) => void;
}

export const artifactKey = (chatId: string, id: string) => `${chatId}:${id}`;

export const useArtifactView = create<ArtifactViewStore>((set, get) => ({
  open: null,
  expanded: false,
  latest: {},
  openArtifact: (chatId, id, version = null) => set({ open: { chatId, id, version } }),
  close: () => set({ open: null, expanded: false }),
  setExpanded: (expanded) => set({ expanded }),
  noteLatest: (chatId, id, version) => {
    const key = artifactKey(chatId, id);
    if ((get().latest[key] ?? 0) >= version) return;
    set((s) => ({ latest: { ...s.latest, [key]: version } }));
  },
}));
