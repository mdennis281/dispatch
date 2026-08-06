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
import { useRunners } from "../../stores/runners.js";
import { useTerminals } from "../../stores/terminals.js";
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
  const runnerCount = useRunners(
    (s) => s.order.map((id) => s.byId[id]!).filter((r) => r?.chatId === chat.id && r.status === "running").length,
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

  const tabs: TabDef[] = [
    { id: "worktrees", label: "Worktrees", icon: <GitBranch />, count: wtCount },
    { id: "agents", label: "Agents", icon: <Bot />, count: agentsLive },
    { id: "apps", label: "Apps", icon: <AppWindow />, count: runnerCount },
    { id: "terminals", label: "Terminals", icon: <SquareTerminal />, count: termCount },
    { id: "prs", label: "PRs", icon: <GitPullRequest />, count: prOpen },
  ];

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center cm-hairline-b">
        {/* Icon-only: five labelled tabs overflowed the 360px column, so the
            later ones were unreachable. Labels live in the tooltips. */}
        <Tabs iconOnly tabs={tabs} value={tab} onChange={(id) => setTab(id as PanelTab)} />
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
