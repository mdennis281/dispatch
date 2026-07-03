import { useEffect, useState } from "react";
import { GitBranch, TerminalSquare, GitPullRequest } from "lucide-react";
import type { Chat } from "@cm/shared";
import { Tabs, type TabDef } from "../ui/Tabs.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { WorktreesPanel } from "../panels/WorktreesPanel.js";
import { RunnerPanel } from "../panels/RunnerPanel.js";
import { PRsPanel } from "../panels/PRsPanel.js";
import { usePanels } from "../../stores/panels.js";
import { useRunners } from "../../stores/runners.js";
import {
  worktreeMatchesChat,
  FOCUS_PANEL_EVENT,
  type FocusPanelTab,
} from "../panels/panelBus.js";

type PanelTab = FocusPanelTab;

export function RightPanel({ chat }: { chat: Chat }) {
  const [tab, setTab] = useState<PanelTab>("worktrees");

  // Let the command palette jump straight to a tab (Worktrees / Apps / PRs).
  useEffect(() => {
    const onFocus = (e: Event) => {
      const next = (e as CustomEvent<FocusPanelTab>).detail;
      if (next === "worktrees" || next === "apps" || next === "prs") setTab(next);
    };
    window.addEventListener(FOCUS_PANEL_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_PANEL_EVENT, onFocus);
  }, []);

  const wtCount = usePanels((s) => s.worktrees.filter((w) => worktreeMatchesChat(w, chat)).length);
  const runnerCount = useRunners(
    (s) => s.order.map((id) => s.byId[id]!).filter((r) => r?.chatId === chat.id && r.status === "running").length,
  );
  const chatPrNumbers = new Set(chat.prs.map((p) => p.number));
  const prOpen = usePanels((s) => s.prs.filter((p) => p.state === "open" && chatPrNumbers.has(p.number)).length);

  const tabs: TabDef[] = [
    { id: "worktrees", label: "Worktrees", icon: <GitBranch />, count: wtCount },
    { id: "apps", label: "Apps", icon: <TerminalSquare />, count: runnerCount },
    { id: "prs", label: "PRs", icon: <GitPullRequest />, count: prOpen },
  ];

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center cm-hairline-b">
        <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as PanelTab)} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "worktrees" && <WorktreesPanel chat={chat} />}
        {tab === "apps" && <RunnerPanel chat={chat} />}
        {tab === "prs" && <PRsPanel chat={chat} />}
      </ScrollArea>
    </aside>
  );
}
