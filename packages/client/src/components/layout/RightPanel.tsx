import { useEffect } from "react";
import { GitBranch, Bot, AppWindow, SquareTerminal, GitPullRequest, Ship, Play } from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { Tabs, type TabDef } from "../ui/Tabs.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Badge } from "../ui/Chip.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { WorktreesPanel } from "../panels/WorktreesPanel.js";
import { AgentsPanel } from "../panels/AgentsPanel.js";
import { RunnerPanel } from "../panels/RunnerPanel.js";
import { TerminalsPanel } from "../panels/TerminalsPanel.js";
import { PRsPanel } from "../panels/PRsPanel.js";
import { usePanelCounts, appsTip } from "../panels/usePanelCounts.js";
import { cn } from "../../lib/cn.js";
import { useProcesses } from "../../stores/processes.js";
import {
  useLayout,
  PANEL_GROUP,
  GROUP_HOME,
  type PanelGroup as PanelGroupId,
} from "../../stores/layout.js";
import { type FocusPanelTab } from "../panels/panelBus.js";

type PanelTab = FocusPanelTab;

/**
 * The five panels split cleanly in two, and the split is what buys their names
 * back.
 *
 * Five labelled tabs need ~400px and the column is 360, so the strip had been
 * collapsed to icon-only with a hover-driven label slot standing in for the
 * vocabulary. That worked, but it meant the words "Terminals" and "Worktrees"
 * appeared nowhere until you swept a mouse across the header.
 *
 * Grouping asks a question the panels already answer: "ship" is the state of
 * your CHANGE (the worktree it lives in, the PR it became), "run" is the state
 * of your PROCESSES (subagents, terminals, dev servers). Two or three labelled
 * tabs per group fit the column with room to spare, and the group you aren't
 * looking at keeps a rolled-up badge so nothing can go unnoticed behind it.
 *
 * The grouping itself now lives in `stores/layout` (`PANEL_GROUP`), because the
 * mobile bottom nav's Ship/Run slots are the same two groups and a second copy
 * of the map is a second answer to "which pane is Terminals in?".
 */

export function RightPanel({ chat }: { chat: Chat }) {
  // The selected tab is store state, not `useState`: the command palette and the
  // mobile bottom nav both select tabs from outside this component. See
  // stores/layout.
  const tab = useLayout((s) => s.panelTab);
  const setTab = useLayout((s) => s.setPanelTab);
  const mode = useLayout((s) => s.mode);
  const group = PANEL_GROUP[tab];

  // Shared with the mobile bottom nav, so a nav badge and a tab badge can never
  // disagree. See panels/usePanelCounts.
  const counts = usePanelCounts(chat);

  // Orphaned dev servers are the one thing in here you have to be TOLD about:
  // they hold a port with no runner behind them, so nothing else in the UI
  // reflects them and the next launch just fails with "port already in use".
  // The scan lives in ProcessesPanel, which is two collapses deep inside Apps —
  // so run it here, where the panel's visibility can't gate it. Not a poll: the
  // triggers are a project switch and a runner start/stop, which is exactly when
  // an orphan appears or is reaped.
  // …and re-scan when a shell appears or goes away, because a chat's own dev
  // server is now a row too: the Terminals cards render the ports attributed to
  // each shell, and without this trigger a server started mid-session would show
  // no port until something unrelated happened to rescan.
  useEffect(() => {
    void useProcesses.getState().scan(chat.projectId);
    // `shells`, not `terminals`: the badge counts only ACTIVE shells now, so an
    // idle shell opening or closing wouldn't move it — and that edge is exactly
    // when a port appears or is released.
  }, [chat.projectId, counts.runners, counts.shells, counts.background]);

  const shipTabs: TabDef[] = [
    { id: "worktrees", label: "Worktrees", icon: <GitBranch />, count: counts.worktrees },
    { id: "prs", label: "PRs", icon: <GitPullRequest />, count: counts.prs },
  ];
  const runTabs: TabDef[] = [
    { id: "agents", label: "Agents", icon: <Bot />, count: counts.agents },
    { id: "terminals", label: "Terminals", icon: <SquareTerminal />, count: counts.terminals },
    {
      id: "apps",
      label: "Apps",
      icon: <AppWindow />,
      count: counts.apps,
      // The tip keeps the summed badge honest — "3" alone can't say how much of
      // it is orphans.
      tip: appsTip(counts),
    },
  ];

  const tabs = group === "ship" ? shipTabs : runTabs;

  return (
    <aside
      className={cn(
        "flex flex-col border-l border-line bg-surface",
        // Below `lg` this column is inside a `Drawer`, which owns the width —
        // as a 360px sheet on a tablet, as the full main area on a phone. Only
        // the `lg` branch is the original inline column.
        mode === "lg" ? "w-[360px] shrink-0" : "h-full w-full",
      )}
    >
      <div className="flex h-9 shrink-0 items-center px-2 pt-1.5">
        <SegmentedControl
          className="w-full [&>button]:flex-1"
          segments={[
            {
              value: "ship",
              label: "Ship",
              icon: <Ship />,
              // Only the group you're NOT on needs a badge; the one you're
              // looking at is already showing its per-tab counts below.
              badge:
                group !== "ship" && counts.ship > 0 ? (
                  <span className="ml-1">
                    <Badge count={counts.ship} tone="warn" />
                  </span>
                ) : undefined,
            },
            {
              value: "run",
              label: "Run",
              icon: <Play />,
              badge:
                group !== "run" && counts.run > 0 ? (
                  <span className="ml-1">
                    <Badge count={counts.run} tone="warn" />
                  </span>
                ) : undefined,
            },
          ]}
          value={group}
          onChange={(g) => setTab(GROUP_HOME[g as PanelGroupId])}
        />
      </div>
      <div className="flex h-9 shrink-0 items-center cm-hairline-b">
        <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as PanelTab)} />
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
