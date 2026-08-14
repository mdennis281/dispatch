/**
 * The app-wide settings, live in the client.
 *
 * The Settings modal has always fetched `GET /api/settings` on open and thrown
 * the result away on close, which is fine for settings only that modal reads.
 * `showInjectedContext` is not one of those: the transcript needs it on every
 * render, as the bottom of the chat → project → app → off fallback. So the
 * settings that other surfaces consult live here, hydrated once at startup and
 * refreshed whenever the modal saves.
 *
 * Only the fields something outside the modal actually reads are kept. This is
 * not a mirror of AppSettings — a store that duplicates the whole shape invites
 * two sources of truth for things (theme, webhook) that already have one.
 */
import { create } from "zustand";
import type { AppSettings } from "../lib/api.js";
import { SHELL_TRANSCRIPT_CATEGORIES, type ShellTranscriptFilter } from "@dispatch/shared";

interface SettingsStore {
  /** App-wide default for showing Dispatch-attached context in transcripts. */
  showInjectedContext: boolean;
  shellFilter: ShellTranscriptFilter;
  /** Apply a freshly-fetched or freshly-saved AppSettings payload. */
  apply: (settings: Partial<AppSettings>) => void;
}

export const useSettings = create<SettingsStore>((set) => ({
  showInjectedContext: false,
  shellFilter: [...SHELL_TRANSCRIPT_CATEGORIES],
  apply: (settings) =>
    set({
      showInjectedContext: settings.showInjectedContext ?? false,
      shellFilter: settings.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES],
    }),
}));
