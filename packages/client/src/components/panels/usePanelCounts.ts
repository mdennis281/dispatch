/**
 * The five right-panel badges, and the two group roll-ups over them.
 *
 * Extracted from `RightPanel` because the mobile bottom nav's Ship and Run slots
 * wear the SAME rolled-up counts, and a nav badge that disagrees with the tab
 * badge it navigates to is worse than no badge — it's a number you learn not to
 * trust. One hook, two call sites, one answer.
 *
 * The orphan re-scan that used to sit beside these counts deliberately did NOT
 * move here: it is an effect with a side effect on a shared store, and a hook
 * used twice would run it twice. It stays in `RightPanel`.
 */
import { useMemo } from "react";
import type { Chat } from "@dispatch/shared";
import { usePanels } from "../../stores/panels.js";
import { useRunners, belongsToChat } from "../../stores/runners.js";
import { isActiveTerminal, isLiveChatTerminal, useTerminals } from "../../stores/terminals.js";
import { useOrphanCount } from "../../stores/processes.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import { worktreeMatchesChat } from "./panelBus.js";

export interface PanelCounts {
  worktrees: number;
  prs: number;
  agents: number;
  /**
   * Shells that are running a command or hosting a background server — the
   * Terminals tab badge. Deliberately NOT every live shell: see
   * `isActiveTerminal`.
   */
  terminals: number;
  /**
   * Every live shell, idle ones included. Not a badge: it's the edge that has to
   * trigger the orphan re-scan, because a shell opening or closing is when a
   * port appears or is released — and `terminals` no longer moves for an idle
   * one.
   */
  shells: number;
  /**
   * Running sub-apps only. Kept separate from `apps` because it is the correct
   * trigger for the orphan re-scan: `apps` INCLUDES the orphan count, so an
   * effect keyed on it would re-scan in response to its own result.
   */
  runners: number;
  /** Running sub-apps + orphaned dev servers — the Apps tab badge. */
  apps: number;
  /** Only the orphans, so a caller can spell the sum out in a tooltip. */
  orphans: number;
  /**
   * Background shells. Not a badge: it's the edge that has to trigger the orphan
   * re-scan, because a background command starts in a shell that ALREADY exists
   * (the shell count doesn't move, but a port is about to appear).
   */
  background: number;
  /** Ship group roll-up. */
  ship: number;
  /** Run group roll-up. */
  run: number;
}

/**
 * `chat` is nullable for the bottom nav, which renders whether or not a chat is
 * open (on the Memory view, or right after a project switch closes one). Every
 * count is then 0, which is exactly right: there is nothing to badge. Hooks
 * can't be called conditionally, so the alternative would have been a second
 * component that exists only to have a chat.
 */
export function usePanelCounts(chat: Chat | null): PanelCounts {
  const worktrees = usePanels(
    (s) => (chat ? s.worktrees.filter((w) => worktreeMatchesChat(w, chat)).length : 0),
  );
  // Same membership rule the panel renders with (see `belongsToChat`), so the
  // badge can't promise a count the tab then fails to show.
  const runnerCount = useRunners((s) =>
    chat
      ? s.order
          .map((id) => s.byId[id]!)
          .filter((r) => r && r.status === "running" && belongsToChat(r, chat.id, chat.projectId))
          .length
      : 0,
  );
  // Same rule the panel expands a card by DEFAULT. Not an equality with the
  // number of open cards — a human can expand a finished shell to read it —
  // but what the badge counts is exactly what opens on its own.
  const terminals = useTerminals((s) =>
    chat
      ? s.order
          .map((id) => s.byId[id])
          .filter((t) => isLiveChatTerminal(t, chat.id) && isActiveTerminal(t)).length
      : 0,
  );
  const shells = useTerminals((s) =>
    chat
      ? s.order.map((id) => s.byId[id]).filter((t) => isLiveChatTerminal(t, chat.id)).length
      : 0,
  );
  const background = useTerminals((s) =>
    chat
      ? s.order.map((id) => s.byId[id]!).filter((t) => t?.chatId === chat.id && t.background).length
      : 0,
  );
  const chatPrNumbers = new Set((chat?.prs ?? []).map((p) => p.number));
  const prs = usePanels((s) =>
    chat ? s.prs.filter((p) => p.state === "open" && chatPrNumbers.has(p.number)).length : 0,
  );

  // Badge the LIVE runs only — a finished run isn't something to act on, and a
  // long chat would otherwise wear a permanent "31" that means nothing.
  const runs = useSubagentRuns(chat?.id ?? "");
  const agents = useMemo(() => runs.filter((r) => r.status === "running").length, [runs]);

  const orphans = useOrphanCount(chat?.projectId);
  // Orphans count toward Apps: both are processes that tab is the only place to
  // see, and an orphan is the more urgent of the two.
  const apps = runnerCount + orphans;

  return {
    worktrees,
    prs,
    agents,
    terminals,
    shells,
    runners: runnerCount,
    apps,
    orphans,
    background,
    ship: worktrees + prs,
    run: agents + terminals + apps,
  };
}

/** How the Apps badge breaks down, for a tooltip. `undefined` when there's nothing to explain. */
export function appsTip(counts: PanelCounts): string | undefined {
  if (counts.orphans === 0) return undefined;
  return `Apps · ${counts.runners} running, ${counts.orphans} orphan${counts.orphans === 1 ? "" : "s"}`;
}
