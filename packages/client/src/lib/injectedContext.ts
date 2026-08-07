/**
 * Whether a chat's transcript shows the context Dispatch attached on your
 * behalf — the memories it surfaced for a turn, the working-tree snapshot it
 * stapled to a sweep, and whatever else grows into that category later.
 *
 * Three levels, most specific first:
 *
 *   1. the chat  (`chat.showInjectedContext`) — "for this conversation"
 *   2. the project (`.dispatch/project.yaml` → `defaults.showInjectedContext`),
 *      committed, so a repo whose work wants auditing gets it for everyone
 *   3. the app (`settings.showInjectedContext`) — how you like to work
 *   4. off
 *
 * Each level is `undefined` when it doesn't answer, which is what makes the
 * chain work: a chat that has never been toggled inherits, and toggling it back
 * to inherit is a real state rather than "false". None of this changes what the
 * model receives — the context was attached either way, and this decides only
 * whether the transcript admits it.
 */
import { useChats } from "../stores/chats.js";
import { useConfig } from "../stores/config.js";
import { useSettings } from "../stores/settings.js";

/** One level of the chain, for UI that explains where a value came from. */
export type InjectedContextSource = "chat" | "project" | "app" | "default";

export interface InjectedContextSetting {
  /** The resolved answer the transcript uses. */
  show: boolean;
  /** Which level answered — drives the "inheriting from…" hint. */
  source: InjectedContextSource;
  /** What this chat would fall back to if its own override were cleared. */
  inherited: boolean;
}

/** Resolve the chain for a chat. Safe to call with a chat that doesn't exist. */
export function useInjectedContext(chatId: string | null): InjectedContextSetting {
  const chatValue = useChats((s) =>
    chatId ? s.byId[chatId]?.showInjectedContext : undefined,
  );
  const projectId = useChats((s) => (chatId ? s.byId[chatId]?.projectId : undefined));
  const projectValue = useConfig((s) =>
    projectId ? s.byProject[projectId]?.config?.defaults?.showInjectedContext : undefined,
  );
  const appValue = useSettings((s) => s.showInjectedContext);

  const inheritedSource: InjectedContextSource =
    projectValue !== undefined ? "project" : appValue ? "app" : "default";
  const inherited = projectValue ?? appValue ?? false;

  return chatValue === undefined
    ? { show: inherited, source: inheritedSource, inherited }
    : { show: chatValue, source: "chat", inherited };
}

/** Human label for where the current answer came from. */
export function injectedContextSourceLabel(source: InjectedContextSource): string {
  switch (source) {
    case "chat":
      return "set for this chat";
    case "project":
      return "from this project's config";
    case "app":
      return "from your app settings";
    default:
      return "off by default";
  }
}
