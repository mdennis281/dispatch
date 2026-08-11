import { useEffect, useMemo, useState } from "react";
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
 */
type PanelGroup = "ship" | "run";

const GROUP_OF: Record<PanelTab, PanelGroup> = {
  worktrees: "ship",
  prs: "ship",
  agents: "run",
  terminals: "run",
  apps: "run",
};

export function RightPanel({ chat }: { chat: Chat }) {
  const [tab, setTab] = useState<PanelTab>("worktrees");
  const group = GROUP_OF[tab];

  // Let the command palette jump straight to a tab (Worktrees / Apps / Terminals / PRs / Agents).
  // Selecting the tab is enough to select its group — the group is derived, so
  // a deep link can't land on a tab whose group is hidden.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const next = (e as CustomEvent<FocusPanelTab>).detail;
      if (next in GROUP_OF) setTab(next);
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
  // Counted separately from `termCount` because a background command starts in a
  // shell that ALREADY exists — the shell count doesn't move, but a port is about
  // to appear. This is the edge that has to trigger the rescan below.
  const bgCount = useTerminals(
    (s) => s.order.map((id) => s.byId[id]!).filter((t) => t?.chatId === chat.id && t.background).length,
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
  // …and re-scan when a shell appears or goes away, because a chat's own dev
  // server is now a row too: the Terminals cards render the ports attributed to
  // each shell, and without this trigger a server started mid-session would show
  // no port until something unrelated happened to rescan.
  const orphanCount = useOrphanCount(chat.projectId);
  useEffect(() => {
    void useProcesses.getState().scan(chat.projectId);
  }, [chat.projectId, runnerCount, termCount, bgCount]);

  const shipTabs: TabDef[] = [
    { id: "worktrees", label: "Worktrees", icon: <GitBranch />, count: wtCount },
    { id: "prs", label: "PRs", icon: <GitPullRequest />, count: prOpen },
  ];
  const runTabs: TabDef[] = [
    { id: "agents", label: "Agents", icon: <Bot />, count: agentsLive },
    { id: "terminals", label: "Terminals", icon: <SquareTerminal />, count: termCount },
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
  ];

  const shipCount = wtCount + prOpen;
  const runCount = agentsLive + termCount + runnerCount + orphanCount;
  const tabs = group === "ship" ? shipTabs : runTabs;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
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
                group !== "ship" && shipCount > 0 ? (
                  <span className="ml-1">
                    <Badge count={shipCount} tone="warn" />
                  </span>
                ) : undefined,
            },
            {
              value: "run",
              label: "Run",
              icon: <Play />,
              badge:
                group !== "run" && runCount > 0 ? (
                  <span className="ml-1">
                    <Badge count={runCount} tone="warn" />
                  </span>
                ) : undefined,
            },
          ]}
          value={group}
          onChange={(g) => setTab(g === "ship" ? "worktrees" : "agents")}
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
