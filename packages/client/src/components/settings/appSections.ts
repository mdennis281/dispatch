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
import {
  Bell,
  Layers,
  MessageSquare,
  Palette,
  Power,
  ShieldCheck,
  ArrowUpCircle,
  type LucideIcon,
} from "lucide-react";
import type { AppSettingsSection } from "../../stores/view.js";

export interface AppSectionDef {
  id: AppSettingsSection;
  icon: LucideIcon;
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
      "Saved server-side, so every browser and device you open Dispatch in agrees. The picker " +
      "previews live — you can't judge a palette from the word for it — so leaving without " +
      "saving keeps the preview until you discard it.",
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
    id: "notifications",
    icon: Bell,
    label: "Notifications",
    blurb: "Desktop toasts and push webhooks",
    explainer:
      "How Dispatch reaches you when an agent needs a decision or finishes one. Desktop " +
      "notifications are per browser; the webhook is per install and reaches your phone.",
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
