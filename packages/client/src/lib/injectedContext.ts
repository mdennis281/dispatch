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
import { layerSourceLabel, resolveLayered, type LayerSource } from "@dispatch/shared";
import { useChats } from "../stores/chats.js";
import { useProjectLayer } from "../stores/config.js";
import { useSettings } from "../stores/settings.js";

/** One level of the chain, for UI that explains where a value came from. */
export type InjectedContextSource = LayerSource;

export interface InjectedContextSetting {
  /** The resolved answer the transcript uses. */
  show: boolean;
  /** Which level answered — drives the "inheriting from…" hint. */
  source: InjectedContextSource;
  /** What this chat would fall back to if its own override were cleared. */
  inherited: boolean;
  /** Which level `inherited` comes from. */
  inheritedSource: InjectedContextSource;
}

/**
 * Resolve the chain for a chat. Safe to call with a chat that doesn't exist.
 * Through `resolveLayered`, so this answers exactly what every other layered
 * setting answers — and so the app's explicit `false` is a pin, not an absence.
 */
export function useInjectedContext(chatId: string | null): InjectedContextSetting {
  const chatValue = useChats((s) =>
    chatId ? s.byId[chatId]?.showInjectedContext : undefined,
  );
  const projectId = useChats((s) => (chatId ? s.byId[chatId]?.projectId : undefined));
  const projectValue = useProjectLayer(projectId)?.showInjectedContext;
  const appValue = useSettings((s) => s.app.showInjectedContext);

  const r = resolveLayered({ chat: chatValue, project: projectValue, app: appValue }, false);
  return {
    show: r.effective,
    source: r.source,
    inherited: r.inherited,
    inheritedSource: r.inheritedSource,
  };
}

/** Human label for where the current answer came from. */
export function injectedContextSourceLabel(source: InjectedContextSource): string {
  return layerSourceLabel(source, "off by default");
}
