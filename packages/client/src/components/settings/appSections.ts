/**
 * The app-settings section registry.
 *
 * The old Settings modal was one 480px column with seven unrelated concerns
 * stacked end to end and no way to jump to any of them — "where do I change the
 * update channel" was answered by scrolling. Every entry here carries a `blurb`
 * because at `sm` the rail IS the index page, and a list of seven one-word
 * labels is a menu you have to open all of to read.
 *
 * The union itself lives in stores/view — it's navigation state before it's a
 * list of panes, and the palette addresses it directly.
 */
import type { ComponentType } from "react";
import { useMemo } from "react";
import {
  Bell,
  BookMarked,
  KeyRound,
  Layers,
  MessageSquare,
  Palette,
  Plug,
  Power,
  Puzzle,
  Archive,
  ShieldCheck,
  ShieldOff,
  ArrowUpCircle,
} from "lucide-react";
import type { AppSettingsSection } from "../../stores/view.js";
import { useSlots, type Registered } from "../../plugins/slots.js";
import type { SettingsSectionDef } from "@dispatch/shared";

export interface AppSectionDef {
  id: AppSettingsSection;
  /** A lucide icon, or any component taking `className` — a plugin's icon is the latter. */
  icon: ComponentType<{ className?: string }>;
  label: string;
  blurb: string;
  /** Shown under the heading in the detail pane. Omitted where the section's
   *  own component already opens with an explanation (auth, updates, system). */
  explainer?: string;
}

export const APP_SECTIONS: AppSectionDef[] = [
  {
    id: "appearance",
    icon: Palette,
    label: "Appearance",
    blurb: "Light, dark, or follow the OS",
    explainer:
      "Remembered by this browser only, so a phone and a desktop can each keep their own. " +
      "Takes effect the moment you pick it — there is nothing to save.",
  },
  {
    id: "chat",
    icon: MessageSquare,
    label: "Chat",
    blurb: "What a new chat starts as",
    explainer:
      "The bottom of every inheritance chain in the app: a project can override these for " +
      "everyone working in its repo, and a single chat can override both. Nothing here changes " +
      "a chat that already exists.",
  },
  {
    id: "permissions",
    icon: ShieldOff,
    label: "Permissions",
    blurb: "Tools that never ask first",
    explainer:
      "Every chat, every project, every mode. Saved the moment you change it, because a " +
      "permission card's \"Always allow\" writes to the same list.",
  },
  {
    id: "accounts",
    icon: KeyRound,
    label: "Accounts",
    blurb: "Several accounts per provider",
    explainer:
      "For a hosted provider an account is a config directory holding a login made by that " +
      "provider's own CLI; for a local-model provider it is the machine serving the models. " +
      "A chat runs under one account, picked from its composer; switching keeps the " +
      "conversation. Which account a new chat starts on is set per provider under Chat.",
  },
  {
    id: "context",
    icon: Layers,
    label: "Context",
    blurb: "How many chats run at once, and token limits",
    explainer:
      "How many chats Dispatch will run at the same time — the rest wait their turn as " +
      "Queued — and what happens as a session's context window fills. Left alone, a full " +
      "window is an error; with auto-compaction on it's a summary and a continuation.",
  },
  {
    id: "retention",
    icon: Archive,
    label: "Retention",
    blurb: "How much history loads, and how long it is kept",
    explainer:
      "Two different questions. How many chats LOAD is a limit on what is on screen — nothing " +
      "is deleted and everything stays reachable. The windows below are the ones that actually " +
      "delete, and the last of them deletes conversations.",
  },
  {
    id: "agent-context",
    icon: BookMarked,
    label: "Agent context",
    blurb: "House rules and memory, on every turn",
    explainer:
      "What every agent is handed before it reads a word of the task. Unlike the rest of " +
      "Settings this is not a preference — it is tokens, paid on every turn of every chat, " +
      "so each control here is bounded and shows what it costs. A project can override any " +
      "of it in its own settings.",
  },
  {
    id: "notifications",
    icon: Bell,
    label: "Notifications",
    blurb: "Desktop toasts and push webhooks",
    explainer:
      "How Dispatch reaches you when an agent needs a decision or finishes one. Desktop " +
      "notifications are per browser; the webhook is per install and reaches your phone.",
  },
  {
    id: "plugins",
    icon: Puzzle,
    label: "Plugins",
    blurb: "Extensions installed on this machine",
    explainer:
      "Built-in plugins ship with Dispatch (the Codex and goose providers) and update with " +
      "it. Installed ones are loaded from the shared config directory, so both the " +
      "installed app and a dev server see the same list. Each row says what the plugin " +
      "declared it will touch. Turning one off takes effect now; turning one on, or " +
      "changing its files, needs a restart.",
  },
  {
    id: "auth",
    icon: ShieldCheck,
    label: "Authentication",
    blurb: "Who can reach this instance",
    explainer:
      "Dispatch listens on your network, not just localhost. This is the gate in front of it.",
  },
  {
    id: "integrations",
    icon: Plug,
    label: "Integrations",
    blurb: "Tokens and webhooks for outside tools",
    explainer:
      "How something that is not a browser talks to this instance. Inbound, a token: shown " +
      "once when it is made, carrying only the scopes you give it, revoked with authentication. " +
      "Outbound, a webhook: a signed POST of the events you pick to a URL you own, with a week " +
      "of delivery history. Both apply the moment you confirm them, not with the bar below.",
  },
  {
    id: "updates",
    icon: ArrowUpCircle,
    label: "Updates",
    blurb: "Channel, version, and installing",
    explainer:
      "Which stream of builds this install follows, what's on it, and whether you want it. " +
      "Renders nothing on a build run from source, where an update control would be a lie.",
  },
  {
    id: "system",
    icon: Power,
    label: "System",
    blurb: "Stop the server",
    explainer:
      "The one control in Settings that ends the session — for you and for every agent " +
      "currently running.",
  },
];

export const APP_SECTION_BY_ID = new Map(APP_SECTIONS.map((s) => [s.id, s]));

/** A plugin's section as the rail and the palette see it. Keyed by its namespaced slot key. */
export function pluginSectionDef(entry: Registered<SettingsSectionDef>): AppSectionDef {
  return { id: entry.key, icon: entry.def.icon, label: entry.def.label, blurb: entry.def.blurb };
}

/**
 * Every section: the built-ins above, then whatever plugins registered
 * (`host.slots.settingsSection`), in registration order. A hook, because a
 * plugin activates after first paint and the rail has to pick it up.
 */
export function useAppSections(): AppSectionDef[] {
  const plugins = useSlots((s) => s.settingsSections);
  return useMemo(
    () => (plugins.length ? [...APP_SECTIONS, ...plugins.map(pluginSectionDef)] : APP_SECTIONS),
    [plugins],
  );
}
