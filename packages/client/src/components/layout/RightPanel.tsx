import { useEffect, useMemo, useState } from "react";
import { GitBranch, Bot, AppWindow, SquareTerminal, GitPullRequest } from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { Tabs, type TabDef } from "../ui/Tabs.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { WorktreesPanel } from "../panels/WorktreesPanel.js";
import { AgentsPanel } from "../panels/AgentsPanel.js";
import { RunnerPanel } from "../panels/RunnerPanel.js";
import { TerminalsPanel } from "../panels/TerminalsPanel.js";
import { PRsPanel } from "../panels/PRsPanel.js";
import { usePanels } from "../../stores/panels.js";
import { useRunners, belongsToChat } from "../../stores/runners.js";
import { useTerminals } from "../../stores/terminals.js";
import { useProcesses, useOrphanCount } from "../../stores/processes.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import {
  worktreeMatchesChat,
  FOCUS_PANEL_EVENT,
  type FocusPanelTab,
} from "../panels/panelBus.js";

type PanelTab = FocusPanelTab;

export function RightPanel({ chat }: { chat: Chat }) {
  const [tab, setTab] = useState<PanelTab>("worktrees");

  // Let the command palette jump straight to a tab (Worktrees / Apps / Terminals / PRs / Memory).
  useEffect(() => {
    const onFocus = (e: Event) => {
      const next = (e as CustomEvent<FocusPanelTab>).detail;
      if (
        next === "worktrees" ||
        next === "agents" ||
        next === "apps" ||
        next === "terminals" ||
        next === "prs"
      ) {
        setTab(next);
      }
    };
    window.addEventListener(FOCUS_PANEL_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_PANEL_EVENT, onFocus);
  }, []);

  const wtCount = usePanels((s) => s.worktrees.filter((w) => worktreeMatchesChat(w, chat)).length);
  // Same membership rule the panel renders with (see `belongsToChat`), so the
  // badge can't promise a count the tab then fails to show.
  const runnerCount = useRunners(
    (s) =>
      s.order
        .map((id) => s.byId[id]!)
        .filter((r) => r && r.status === "running" && belongsToChat(r, chat.id, chat.projectId))
        .length,
  );
  const termCount = useTerminals(
    (s) => s.order.map((id) => s.byId[id]!).filter((t) => t?.chatId === chat.id && t.status === "live").length,
  );
  const chatPrNumbers = new Set(chat.prs.map((p) => p.number));
  const prOpen = usePanels((s) => s.prs.filter((p) => p.state === "open" && chatPrNumbers.has(p.number)).length);

  // Badge the LIVE runs only — a finished run isn't something to act on, and a
  // long chat would otherwise wear a permanent "31" that means nothing.
  const runs = useSubagentRuns(chat.id);
  const agentsLive = useMemo(
    () => runs.filter((r) => r.status === "running").length,
    [runs],
  );

  // Orphaned dev servers are the one thing in here you have to be TOLD about:
  // they hold a port with no runner behind them, so nothing else in the UI
  // reflects them and the next launch just fails with "port already in use".
  // The scan lives in ProcessesPanel, which is two collapses deep inside Apps —
  // so run it here, where the panel's visibility can't gate it. Not a poll: the
  // triggers are a project switch and a runner start/stop, which is exactly when
  // an orphan appears or is reaped.
  const orphanCount = useOrphanCount(chat.projectId);
  useEffect(() => {
    void useProcesses.getState().scan(chat.projectId);
  }, [chat.projectId, runnerCount]);

  const tabs: TabDef[] = [
    { id: "worktrees", label: "Worktrees", icon: <GitBranch />, count: wtCount },
    { id: "agents", label: "Agents", icon: <Bot />, count: agentsLive },
    {
      id: "apps",
      label: "Apps",
      icon: <AppWindow />,
      // Orphans count toward the badge: both are processes this tab is the only
      // place to see, and an orphan is the more urgent of the two. The tip keeps
      // the sum honest, since "3" alone can't say which is which.
      count: runnerCount + orphanCount,
      tip:
        orphanCount > 0
          ? `Apps · ${runnerCount} running, ${orphanCount} orphan${orphanCount === 1 ? "" : "s"}`
          : undefined,
    },
    { id: "terminals", label: "Terminals", icon: <SquareTerminal />, count: termCount },
    { id: "prs", label: "PRs", icon: <GitPullRequest />, count: prOpen },
  ];

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center cm-hairline-b">
        {/* Icon-only: five labelled tabs overflowed the 360px column, so the
            later ones were unreachable. `labelSlot` buys the vocabulary back
            inside the budget — the strip is 196px, the label sits in the 164px
            the icons freed and names whichever tab the mouse is over. */}
        <Tabs
          iconOnly
          labelSlot
          tabs={tabs}
          value={tab}
          onChange={(id) => setTab(id as PanelTab)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "worktrees" && <WorktreesPanel chat={chat} />}
        {tab === "agents" && <AgentsPanel chat={chat} />}
        {tab === "apps" && <RunnerPanel chat={chat} />}
        {tab === "terminals" && <TerminalsPanel chat={chat} />}
        {tab === "prs" && <PRsPanel chat={chat} />}
      </ScrollArea>
    </aside>
  );
}
