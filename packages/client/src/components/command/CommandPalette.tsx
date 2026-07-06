/**
 * Command palette — the top-bar "Search or run a command" surface. Opens on
 * click or ⌘/Ctrl-K, fuzzy-filters a live command list (switch chat/project, new
 * chat, open settings, jump to a right-panel tab, regenerate title…), and runs
 * the selected command. Fully keyboard-driven: ↑/↓ move, Enter runs, Esc closes.
 * Zero deps — the fuzzy matcher + portal overlay are local.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Plus,
  FolderGit2,
  MessageSquare,
  SlidersHorizontal,
  GitBranch,
  TerminalSquare,
  GitPullRequest,
  Sparkles,
  Blocks,
  FileCog,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { actions } from "../../lib/actions.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { requestFocusPanel, type FocusPanelTab } from "../panels/panelBus.js";
import { requestOpenProjectPrs } from "../prs/projectPrsBus.js";
import { requestOpenMcpCatalog } from "../mcp/mcpCatalogBus.js";
import { requestOpenProjectConfig } from "../config/configViewBus.js";
import { Kbd } from "../ui/Kbd.js";
import { cn } from "../../lib/cn.js";

interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon: ReactNode;
  /** Extra text folded into the fuzzy search (not shown). */
  keywords?: string;
  run: () => void;
}

/**
 * Subsequence fuzzy score: null when `query` isn't a subsequence of `text`,
 * else a score that rewards contiguous runs and word-boundary hits. Empty query
 * → 0 (keep everything in its natural order via a stable sort).
 */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = last === ti - 1 ? streak + 1 : 0;
      const prev = ti > 0 ? t[ti - 1] : undefined;
      const boundary = prev === undefined || /[\s\-_/.]/.test(prev);
      score += 1 + streak * 2 + (boundary ? 3 : 0);
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** Fire-and-focus a new chat (mirrors the sidebar's create+auto-select). */
function newChatAndFocus(projectId: string): void {
  const before = new Set(useChats.getState().order);
  actions.createChat({ projectId, modeId: "auto", effort: "medium" });
  let done = false;
  const unsub = useChats.subscribe((s) => {
    const fresh = s.order.find((id) => !before.has(id));
    if (fresh && !done) {
      done = true;
      unsub();
      clearTimeout(timer);
      useChats.getState().setActiveChat(fresh);
    }
  });
  const timer = setTimeout(() => {
    done = true;
    unsub();
  }, 8000);
}

export function CommandPalette({
  open,
  onOpenChange,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const chatsById = useChats((s) => s.byId);
  const chatOrder = useChats((s) => s.order);
  const activeChatId = useChats((s) => s.activeChatId);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  /* global ⌘/Ctrl-K toggle */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onOpenChange(!openRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  /* reset + focus each time it opens */
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const project = projects.find((p) => p.id === activeProjectId) ?? null;

    if (project) {
      list.push({
        id: "new-chat",
        title: "New chat",
        subtitle: `in ${project.name}`,
        group: "Actions",
        icon: <Plus />,
        keywords: "create start task conversation",
        run: () => newChatAndFocus(project.id),
      });
      // Project-wide open-PR board (distinct from the per-chat "Go to PRs" panel).
      list.push({
        id: "project-prs",
        title: "Open pull requests",
        subtitle: `all open PRs in ${project.name}`,
        group: "Navigate",
        icon: <GitPullRequest />,
        keywords: "pr pull request github review merge hold board project all open",
        run: () => requestOpenProjectPrs(),
      });
      // MCP catalog — every tool endpoint (custom manager + external) for the project.
      list.push({
        id: "mcp-catalog",
        title: "MCP tools",
        subtitle: `every MCP endpoint in ${project.name}`,
        group: "Navigate",
        icon: <Blocks />,
        keywords: "mcp tool endpoint schema server manager show visualize catalog",
        run: () => requestOpenMcpCatalog(),
      });
      // Project config — the loaded `.claude-manager/` (instructions/subApps/
      // MCP/agents/modes/memory) + reload / export / import.
      list.push({
        id: "project-config",
        title: "Project config",
        subtitle: `.claude-manager/ for ${project.name}`,
        group: "Navigate",
        icon: <FileCog />,
        keywords: "config claude-manager manifest instructions subapps mcp agents modes memory export import cm scaffold reload",
        run: () => requestOpenProjectConfig(),
      });
    }

    if (activeChatId) {
      list.push({
        id: "regen-title",
        title: "Regenerate title",
        subtitle: "for the current chat",
        group: "Actions",
        icon: <Sparkles />,
        keywords: "rename ai summarize",
        run: () => actions.regenerateTitle(activeChatId),
      });
      const panelCmds: { id: string; title: string; icon: ReactNode; tab: FocusPanelTab }[] = [
        { id: "go-worktrees", title: "Go to Worktrees", icon: <GitBranch />, tab: "worktrees" },
        { id: "go-apps", title: "Go to Apps", icon: <TerminalSquare />, tab: "apps" },
        { id: "go-terminals", title: "Go to Terminals", icon: <TerminalSquare />, tab: "terminals" },
        { id: "go-prs", title: "Go to PRs", icon: <GitPullRequest />, tab: "prs" },
      ];
      for (const p of panelCmds) {
        list.push({
          id: p.id,
          title: p.title,
          group: "Navigate",
          icon: p.icon,
          keywords: "panel tab jump",
          run: () => requestFocusPanel(p.tab),
        });
      }
    }

    list.push({
      id: "open-settings",
      title: "Open Settings",
      group: "Navigate",
      icon: <SlidersHorizontal />,
      keywords: "preferences theme webhook config gear",
      run: onOpenSettings,
    });

    for (const p of projects) {
      list.push({
        id: `project-${p.id}`,
        title: p.name,
        subtitle: p.id === activeProjectId ? "current project" : "switch project",
        group: "Projects",
        icon: <FolderGit2 />,
        keywords: `project repo ${p.repoPath ?? ""}`,
        run: () => useProjects.getState().setActiveProject(p.id),
      });
    }

    for (const id of chatOrder) {
      const c = chatsById[id];
      if (!c) continue;
      const proj = projects.find((p) => p.id === c.projectId);
      list.push({
        id: `chat-${c.id}`,
        title: c.title || "Untitled chat",
        subtitle: proj ? proj.name : "chat",
        group: "Chats",
        icon: <MessageSquare />,
        keywords: `chat ${proj?.name ?? ""}`,
        run: () => {
          if (c.projectId !== activeProjectId) useProjects.getState().setActiveProject(c.projectId);
          useChats.getState().setActiveChat(c.id);
        },
      });
    }

    return list;
  }, [projects, activeProjectId, chatsById, chatOrder, activeChatId, onOpenSettings]);

  const results = useMemo(() => {
    const scored: { cmd: Command; score: number; i: number }[] = [];
    commands.forEach((cmd, i) => {
      const hay = `${cmd.title} ${cmd.subtitle ?? ""} ${cmd.group} ${cmd.keywords ?? ""}`;
      const score = fuzzyScore(query.trim(), hay);
      if (score !== null) scored.push({ cmd, score, i });
    });
    // stable: by score desc, then original order.
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((s) => s.cmd);
  }, [commands, query]);

  // keep the active index in range as the result set changes.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const runAt = useCallback(
    (idx: number) => {
      const cmd = results[idx];
      if (!cmd) return;
      onOpenChange(false);
      // run after close so a command that opens another surface (Settings) lands last.
      queueMicrotask(() => cmd.run());
    },
    [results, onOpenChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Stop the native event before it reaches document-level Escape listeners
      // (e.g. an open Modal below the ⌘K-summoned palette) so one Escape closes
      // only the palette, not both surfaces.
      e.stopPropagation();
      close();
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-start justify-center p-6 sm:pt-[12vh]">
      <div className="fixed inset-0 bg-black/55 backdrop-blur-[2px]" onClick={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={
          "relative z-10 flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg " +
          "border border-line-strong bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise"
        }
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-3.5 py-3 cm-hairline-b [&_svg]:size-4">
          <Search className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search or run a command…"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-primary placeholder:text-faint outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="cm-scroll max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-10 text-center text-[12.5px] text-muted">
              No commands match “{query}”.
            </div>
          ) : (
            results.map((cmd, idx) => (
              <button
                key={cmd.id}
                data-idx={idx}
                onClick={() => runAt(idx)}
                onMouseMove={() => setActive(idx)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  idx === active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3.5",
                    idx === active
                      ? "border-accent-line bg-accent-ghost text-accent-hi"
                      : "border-line bg-panel-2 text-muted",
                  )}
                >
                  {cmd.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-primary">
                    {cmd.title}
                  </span>
                  {cmd.subtitle && (
                    <span className="block truncate text-[11px] text-muted">{cmd.subtitle}</span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-faint">
                  {cmd.group}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-3.5 py-2 cm-hairline-t text-[10.5px] text-faint">
          <span className="flex items-center gap-1">
            <Kbd>
              <ArrowUp className="size-2.5" />
            </Kbd>
            <Kbd>
              <ArrowDown className="size-2.5" />
            </Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>
              <CornerDownLeft className="size-2.5" />
            </Kbd>
            run
          </span>
          <span className="ml-auto cm-mono">
            {results.length} command{results.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
