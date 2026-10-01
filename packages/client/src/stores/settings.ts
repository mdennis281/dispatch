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
import {
  SHELL_TRANSCRIPT_CATEGORIES,
  type SendMode,
  type ShellTranscriptFilter,
} from "@dispatch/shared";

/**
 * The app LAYER of every layered setting, exactly as the server stores it —
 * `undefined` where the app says nothing, so `resolveLayered` /
 * `resolveChatPosture` can tell "the app turned it off" from "nobody said".
 * (`showInjectedContext` / `shellFilter` above are the pre-resolved reading
 * the transcript wants; these are the raw layer the resolvers want.)
 */
export type AppLayer = Pick<
  AppSettings,
  | "showInjectedContext"
  | "shellFilter"
  | "defaultModeId"
  | "harness"
  | "spawnChat"
  | "defaultSendMode"
  // The reviewer pane reads it to show what a project inherits when it pins
  // nothing — a "Cap: App default" that cannot say WHICH number is no better
  // than a blank.
  | "reviewAgent"
>;

interface SettingsStore {
  /** App-wide default for showing Dispatch-attached context in transcripts. */
  showInjectedContext: boolean;
  shellFilter: ShellTranscriptFilter;
  /** The raw app layer for the resolvers. */
  app: AppLayer;
  /** Apply a freshly-fetched or freshly-saved AppSettings payload. */
  apply: (settings: Partial<AppSettings>) => void;
  /**
   * Pin ONE field: the composer's send-mode default.
   *
   * Not `apply` with a one-field object — `apply` is a full replace (it resolves
   * every field it knows against the payload, so an absent one reads as
   * "cleared"), which is right for a fetched body and catastrophic for an
   * optimistic update. The dropup pins this before its request lands, so it needs
   * a setter that touches nothing else.
   */
  setDefaultSendMode: (mode: SendMode | undefined) => void;
}

export const useSettings = create<SettingsStore>((set) => ({
  showInjectedContext: false,
  shellFilter: [...SHELL_TRANSCRIPT_CATEGORIES],
  app: {},
  apply: (settings) =>
    set({
      showInjectedContext: settings.showInjectedContext ?? false,
      shellFilter: settings.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES],
      app: {
        showInjectedContext: settings.showInjectedContext,
        shellFilter: settings.shellFilter,
        defaultModeId: settings.defaultModeId,
        harness: settings.harness,
        spawnChat: settings.spawnChat,
        defaultSendMode: settings.defaultSendMode,
        reviewAgent: settings.reviewAgent,
      },
    }),
  setDefaultSendMode: (mode) =>
    set((s) => ({ app: { ...s.app, defaultSendMode: mode } })),
}));
