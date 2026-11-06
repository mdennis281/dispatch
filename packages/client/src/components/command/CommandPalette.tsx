/**
 * Command palette — the top-bar "Search or run a command" surface. Opens on
 * click or ⌘/Ctrl-K, fuzzy-filters a live command list (switch chat/project, new
 * chat, open settings, jump to a right-panel tab, regenerate title…), and runs
 * the selected command. Fully keyboard-driven: ↑/↓ move, Enter runs, Esc closes.
 *
 * It also searches the active project's FILES, because "where is that file" is
 * the same shape of question as "where is that setting" and answering it
 * somewhere else means remembering which search box knows about which. Those
 * results come from the server (a browser cannot see a filesystem) through the
 * git-backed index, so they honour `.gitignore` and cost one `git ls-files` per
 * ten seconds rather than a walk per keystroke.
 *
 * File hits are appended AFTER the commands rather than merged into the fuzzy
 * ranking: they're already ranked by the server, and interleaving two scores
 * computed by different scorers produces an order that looks arbitrary from
 * either side. Commands are a closed set you're recalling; files are an open
 * set you're searching — keeping them in that order means typing a command name
 * never gets outbid by a file that happens to share letters.
 *
 * And it searches what was SAID in every chat — the "which chat was it where we
 * talked about the house colours" question, which a title can't answer. That
 * search is a stream: the server walks transcripts newest-first a day at a time
 * (services/chat-search.ts) and the rows grow underneath as older days come
 * in. It stops when the palette closes, the query changes, or history runs out.
 * Those rows go LAST, after files, for the same reason files go after commands,
 * and because a list that only ever grows at the bottom never moves the row
 * your cursor is on.
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
  FolderPlus,
  Globe,
  MessageSquare,
  SlidersHorizontal,
  GitBranch,
  Bot,
  AppWindow,
  SquareTerminal,
  GitPullRequest,
  Sparkles,
  Blocks,
  FileCog,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  Power,
  FolderOpen,
  FileText,
  Workflow,
  MessageSquareText,
  Loader2,
} from "lucide-react";
import { significantTokens, stem, type ChatSearchHit } from "@dispatch/shared";
import { actions } from "../../lib/actions.js";
import { createChatAndFocus } from "../../stores/pendingChat.js";
import { api } from "../../lib/api.js";
import { openCodeViewer } from "../monaco/store.js";
import { useChats } from "../../stores/chats.js";
import { useProjects, useRealProjects } from "../../stores/projects.js";
import { selectChat, selectGlobalChat, selectProject } from "../../stores/navigation.js";
import {
  useView,
  openOverlay,
  openAppSettings,
  openProjectSettings,
} from "../../stores/view.js";
import { openWorkspace } from "../../stores/workspace.js";
import { useAppSections } from "../settings/appSections.js";
import { SECTIONS } from "../config/sections.js";
import { requestFocusPanel, type FocusPanelTab } from "../panels/panelBus.js";
import { Kbd } from "../ui/Kbd.js";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";
import { ago } from "../metrics/chrome.js";

interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon: ReactNode;
  /** Extra text folded into the fuzzy search (not shown). */
  keywords?: string;
  /** A matched passage, shown in place of the subtitle with `terms` marked. */
  snippet?: string;
  terms?: readonly string[];
  /** Small trailing note under the group label — a transcript hit's age. */
  meta?: string;
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

/** Below this, a query is too broad to be worth a round trip per keystroke. */
const FILE_SEARCH_MIN_CHARS = 2;
/** How many file hits the palette shows before the list stops being scannable. */
const FILE_SEARCH_LIMIT = 8;
/** One request per typing pause, not per character. */
const FILE_SEARCH_DEBOUNCE_MS = 140;

/**
 * The active project's files matching `query`, as palette commands.
 *
 * Returns `[]` for a short query or no project rather than an error state: an
 * empty file section is indistinguishable from "still typing", and a palette
 * that flashes a diagnostic while you type is worse than one that shows the
 * commands it already has.
 */
function useProjectFileCommands(
  query: string,
  projectId: string | undefined,
  repoPath: string | undefined,
  open: boolean,
): Command[] {
  const [files, setFiles] = useState<{ rel: string; abs: string }[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!open || !projectId || q.length < FILE_SEARCH_MIN_CHARS) {
      setFiles([]);
      return;
    }
    // `live` rather than an AbortController: the responses are small and the
    // cost worth avoiding is a STALE one overwriting a fresh one, which this
    // covers without the request bookkeeping.
    let live = true;
    const timer = setTimeout(() => {
      api.files
        .searchProject(projectId, q, FILE_SEARCH_LIMIT)
        .then((res) => live && setFiles(res.files))
        .catch(() => live && setFiles([]));
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, projectId, open]);

  return useMemo(
    () =>
      files.map((file) => ({
        id: `file-${file.abs}`,
        title: file.rel.split("/").pop() ?? file.rel,
        // The directory is most of what you wanted to know — two files with the
        // same basename are otherwise indistinguishable rows.
        subtitle: file.rel,
        group: "Files",
        icon: <FileText />,
        run: () =>
          openCodeViewer({
            worktreePath: repoPath ?? "",
            relPath: file.rel,
            mode: "file",
            base: "main",
          }),
      })),
    [files, repoPath],
  );
}

/** Below this, a transcript query matches half of everything ever said. */
const CHAT_SEARCH_MIN_CHARS = 3;
/**
 * Longer than the file search's: each query starts a walk over every
 * transcript, so one per word is the right rate, not one per letter.
 */
const CHAT_SEARCH_DEBOUNCE_MS = 220;
/** Past this the list isn't being read, so the walk stops too. */
const CHAT_SEARCH_MAX_HITS = 150;

interface ChatSearchProgress {
  running: boolean;
  /** How far back the walk has reached, in days. */
  daysBack: number;
  searched: number;
  total: number;
  /** Stopped at {@link CHAT_SEARCH_MAX_HITS} rather than at the end of history. */
  capped?: boolean;
  error?: string;
}

const NO_PROGRESS = { daysBack: 0, searched: 0, total: 0 };

/**
 * Every chat whose transcript matches `query`, growing as the server's age walk
 * reaches older days.
 *
 * The walk is ONE streamed request, and aborting it is the cancel: the effect's
 * cleanup runs on a new query, on close, and on unmount, and the server stops
 * scanning the moment the socket drops. Hits from a superseded query can't
 * land, because the frame callback checks the same signal.
 */
function useChatSearch(
  query: string,
  open: boolean,
): { hits: ChatSearchHit[]; progress: ChatSearchProgress | null } {
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [progress, setProgress] = useState<ChatSearchProgress | null>(null);

  useEffect(() => {
    const q = query.trim();
    setHits([]);
    setProgress(null);
    if (!open || q.length < CHAT_SEARCH_MIN_CHARS) return;
    const abort = new AbortController();
    let count = 0;
    const timer = setTimeout(() => {
      setProgress({ running: true, ...NO_PROGRESS });
      api.chats
        .search(
          q,
          (frame) => {
            if (abort.signal.aborted) return;
            if (frame.type === "hits") {
              if (frame.hits.length) {
                count += frame.hits.length;
                setHits((prev) => [...prev, ...frame.hits]);
              }
              const capped = count >= CHAT_SEARCH_MAX_HITS;
              setProgress({
                running: !capped,
                daysBack: frame.daysBack,
                searched: frame.searched,
                total: frame.total,
                capped,
              });
              if (capped) abort.abort();
            } else if (frame.type === "done") {
              setProgress({
                running: false,
                daysBack: frame.daysBack,
                searched: frame.searched,
                total: frame.total,
              });
            } else {
              setProgress((p) => ({ ...(p ?? NO_PROGRESS), running: false, error: frame.error }));
            }
          },
          abort.signal,
        )
        .catch((err: unknown) => {
          if (abort.signal.aborted) return;
          setProgress((p) => ({
            ...(p ?? NO_PROGRESS),
            running: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        });
    }, CHAT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, open]);

  return { hits, progress };
}

/**
 * The words to mark in a snippet: the query's significant tokens, STEMMED, so
 * "colors" also marks the "color" and "colorful" the scorer credited, not only
 * the literal word.
 */
function highlightTerms(query: string): string[] {
  return [...new Set(significantTokens(query).map(stem).filter((t) => t.length >= 2))];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A snippet on one truncated line, with its matches marked.
 *
 * The server pads ~140 chars either side of the match, which on a one-line row
 * puts the match past the ellipsis — so it is re-centred here to start just
 * before the first marked term.
 */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  // The WHOLE word around a term is marked: a stem is a fragment ("worktree"
  // stems to "worktre"), and a highlight that stops a letter short reads as a
  // rendering bug.
  const re = terms.length
    ? new RegExp(`([\\p{L}\\p{N}_]*(?:${terms.map(escapeRe).join("|")})[\\p{L}\\p{N}_]*)`, "giu")
    : null;
  let shown = text.replace(/\s+/g, " ").trim();
  if (!re) return <>{shown}</>;
  const first = shown.search(re);
  if (first > 40) shown = `…${shown.slice(first - 24).replace(/^\S*\s/, "")}`;
  // A split on a capturing group puts the matches at the odd indices.
  return (
    <>
      {shown.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-accent-ghost px-px text-accent-hi">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useRealProjects();
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

  const appSections = useAppSections();
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
        // Project only — no effort, mode or model. See `startNewChat` in
        // Sidebar.tsx: a value pinned here shadows the project's and the app's
        // defaults instead of falling through to them.
        run: () => createChatAndFocus({ projectId: project.id }),
      });
      // The cross-cutting catalog: worktrees + shells at chat / project / app
      // scope. Distinct from the per-chat right-panel tabs, which only ever
      // show the chat you're in — which is how a stray worktree or a shell in a
      // closed chat stayed invisible.
      list.push({
        id: "workspace",
        title: "Workspace",
        subtitle: "worktrees, terminals and PRs across every scope",
        group: "Navigate",
        icon: <FolderGit2 />,
        keywords:
          "workspace worktree worktrees terminal terminals shell shells catalog registry all everything scope orphan unattributed",
        run: () => openOverlay("workspace"),
      });
      // The file manager: this machine's disks, not just the checkout. Distinct
      // from the file HITS below, which only ever cover the project.
      list.push({
        id: "browse-files",
        title: "Browse files",
        subtitle: "this machine's drives, mounts, projects and worktrees",
        group: "Navigate",
        icon: <FolderOpen />,
        keywords:
          "files file explorer browse folder directory disk drive volume mount path finder manager",
        run: () => useView.getState().setView("files"),
      });
      list.push({
        id: "ci",
        title: "CI/CD",
        subtitle: "workflows, run history, job logs — re-run, cancel, run a workflow",
        group: "Navigate",
        icon: <Workflow />,
        keywords:
          "ci cd ci/cd actions github actions workflow workflows runs pipeline build builds checks jobs logs rerun re-run cancel dispatch deploy",
        run: () => useView.getState().setView("ci"),
      });
      // The tracked-PR catalog (distinct from the per-chat "Go to PRs" panel).
      list.push({
        id: "project-prs",
        title: "Pull requests",
        subtitle: "tracked PRs, with live review and CI state",
        group: "Navigate",
        icon: <GitPullRequest />,
        keywords: "pr pull request github review merge hold board project all open tracked",
        run: () => openWorkspace("prs"),
      });
      // MCP catalog — every tool endpoint (custom manager + external) for the project.
      list.push({
        id: "mcp-catalog",
        title: "MCP tools",
        subtitle: `every MCP endpoint in ${project.name}`,
        group: "Navigate",
        icon: <Blocks />,
        keywords: "mcp tool endpoint schema server manager show visualize catalog",
        run: () => openOverlay("mcp"),
      });
      // Project config — the loaded `.dispatch/` (instructions/subApps/
      // MCP/agents/modes/memory) + reload / export / import.
      list.push({
        id: "project-config",
        title: "Project config",
        subtitle: `.dispatch/ for ${project.name}`,
        group: "Navigate",
        icon: <FileCog />,
        keywords: "config Dispatch manifest instructions subapps mcp agents modes memory export import scaffold reload",
        run: () => openProjectSettings(),
      });
      // One entry per subpage. This is what the modal couldn't do: its section
      // was local state, so "Skills" was somewhere you had to arrive at rather
      // than somewhere you could go. Each section's own `blurb` is the subtitle,
      // so the palette explains what it is on the way there.
      for (const s of SECTIONS) {
        list.push({
          id: `project-config-${s.id}`,
          title: `Project config › ${s.label}`,
          subtitle: s.blurb,
          group: "Navigate",
          icon: <s.icon />,
          keywords: `config Dispatch ${s.noun} ${s.blurb}`,
          run: () => openProjectSettings(s.id),
        });
      }
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
      // The right-panel tabs are icon-only (five labels don't fit 360px), so this
      // is the only place their NAMES are searchable — hence one entry per tab,
      // each icon matching the tab's own, plus the words people actually type
      // when they've lost one ("shell", "orphan", "port").
      const panelCmds: {
        id: string;
        title: string;
        icon: ReactNode;
        tab: FocusPanelTab;
        keywords?: string;
      }[] = [
        { id: "go-worktrees", title: "Go to Worktrees", icon: <GitBranch />, tab: "worktrees" },
        { id: "go-agents", title: "Go to Agents", icon: <Bot />, tab: "agents", keywords: "subagent task run" },
        {
          id: "go-apps",
          title: "Go to Apps",
          icon: <AppWindow />,
          tab: "apps",
          keywords: "subapp runner dev server port process orphan kill",
        },
        {
          id: "go-terminals",
          title: "Go to Terminals",
          icon: <SquareTerminal />,
          tab: "terminals",
          keywords: "shell shells console command",
        },
        { id: "go-prs", title: "Go to PRs", icon: <GitPullRequest />, tab: "prs" },
      ];
      for (const p of panelCmds) {
        list.push({
          id: p.id,
          title: p.title,
          group: "Navigate",
          icon: p.icon,
          keywords: `panel tab jump ${p.keywords ?? ""}`,
          run: () => requestFocusPanel(p.tab),
        });
      }
    }

    list.push({
      id: "open-settings",
      title: "Open Settings",
      group: "Navigate",
      icon: <SlidersHorizontal />,
      keywords: "preferences theme webhook config gear notifications",
      run: () => openAppSettings(),
    });
    for (const s of appSections) {
      list.push({
        id: `settings-${s.id}`,
        title: `Settings › ${s.label}`,
        subtitle: s.blurb,
        group: "Navigate",
        icon: <s.icon />,
        keywords: `settings preferences ${s.blurb}`,
        run: () => openAppSettings(s.id),
      });
    }

    // "How do I quit this thing" is a top-level question, so it gets a top-level
    // answer — but it lands on the confirm rather than firing the stop, because
    // one keystroke away from killing every running agent is too close. It now
    // lands on the SECTION that holds it rather than on a modal you then had to
    // scroll to the bottom of.
    list.push({
      id: "stop-dispatch",
      title: "Stop Dispatch",
      subtitle: "opens Settings › System",
      group: "Actions",
      icon: <Power />,
      keywords: "quit exit shutdown kill halt close server stop app",
      run: () => openAppSettings("system"),
    });

    // Not gated on an active project — this is how the FIRST one gets made, and
    // the palette is the only entry point that works before there's a sidebar
    // selector worth opening.
    list.push({
      id: "new-project",
      title: "New project",
      subtitle: "name it, point it at a directory, let an agent finish the setup",
      group: "Actions",
      icon: <FolderPlus />,
      keywords: "add create project repo directory setup init clone import scaffold",
      run: () => useView.getState().setView("new-project"),
    });

    // The global chat is reachable from here too, but as its OWN command: it
    // is not a project you switch to, and filing it under "Projects" beside
    // real repos is the leak `realProjects` exists to prevent.
    list.push({
      id: "global-chat",
      title: "Global chat",
      subtitle: "cross-project overview — spawn and observe, never land",
      group: "Navigate",
      icon: <Globe />,
      keywords: "global cross project overview spawn everything all",
      run: () => selectGlobalChat(),
    });

    for (const p of projects) {
      list.push({
        id: `project-${p.id}`,
        title: p.name,
        subtitle: p.id === activeProjectId ? "current project" : "switch project",
        group: "Projects",
        icon: <FolderGit2 />,
        keywords: `project repo ${p.repoPath ?? ""}`,
        run: () => selectProject(p.id),
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
        run: () => selectChat(c.id),
      });
    }

    return list;
  }, [projects, activeProjectId, chatsById, chatOrder, activeChatId, appSections]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const fileCommands = useProjectFileCommands(
    query,
    activeProject?.id,
    activeProject?.repoPath,
    open,
  );

  const chatSearch = useChatSearch(query, open);
  const terms = useMemo(() => highlightTerms(query), [query]);

  const results = useMemo(() => {
    const scored: { cmd: Command; score: number; i: number }[] = [];
    commands.forEach((cmd, i) => {
      const hay = `${cmd.title} ${cmd.subtitle ?? ""} ${cmd.group} ${cmd.keywords ?? ""}`;
      const score = fuzzyScore(query.trim(), hay);
      if (score !== null) scored.push({ cmd, score, i });
    });
    // stable: by score desc, then original order.
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    // Files next — see the header note. They arrive already ranked, so folding
    // them into the sort above would re-rank them by a scorer that never saw
    // the repo.
    const listed = scored.map((s) => s.cmd);
    // A chat already listed by its title isn't listed again for its transcript:
    // the same chat twice reads as two chats.
    const shown = new Set(listed.map((c) => c.id));
    const transcript: Command[] = [];
    for (const h of chatSearch.hits) {
      if (shown.has(`chat-${h.chatId}`)) continue;
      const fromRow = h.kind !== "title";
      transcript.push({
        id: `transcript-${h.chatId}`,
        title: h.title || "Untitled chat",
        subtitle: fromRow ? undefined : "matched the title",
        snippet: fromRow ? h.snippet : undefined,
        terms,
        meta: [h.archived ? "archived" : null, ago(h.at)].filter(Boolean).join(" · "),
        group: h.projectName ?? "Chat",
        icon: <MessageSquareText />,
        run: () => selectChat(h.chatId),
      });
    }
    return { all: [...listed, ...fileCommands, ...transcript], transcript: transcript.length };
  }, [commands, query, fileCommands, chatSearch.hits, terms]);
  const transcriptCount = results.transcript;
  const items = results.all;

  // keep the active index in range as the result set changes.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);

  // scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const runAt = useCallback(
    (idx: number) => {
      const cmd = items[idx];
      if (!cmd) return;
      onOpenChange(false);
      // run after close so a command that opens another surface (Settings) lands last.
      queueMicrotask(() => cmd.run());
    },
    [items, onOpenChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
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
    <div
      style={{ zIndex: LAYER.palette }}
      className={
        // Top-anchored: on a phone the 24px gutter alone would put the search
        // field under the status bar. See `dp-safe-pad` in index.css.
        "fixed inset-0 flex items-start justify-center " +
        "dp-safe-pad [--dp-gutter:1.5rem] sm:pt-[max(12vh,var(--dp-safe-top),var(--dp-titlebar-h))]"
      }
    >
      <div className="fixed inset-0 bg-scrim backdrop-blur-[2px]" onClick={close} aria-hidden />
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
            placeholder="Search chats, files or run a command…"
            className="min-w-0 flex-1 bg-transparent text-lg text-primary placeholder:text-faint outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="cm-scroll max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 && chatSearch.progress?.running ? (
            // Not "nothing matches": the walk hasn't reached the chat yet, and
            // saying otherwise is how a search that works gets abandoned.
            <div className="flex items-center justify-center gap-2 px-3 py-10 text-base text-muted">
              <Loader2 className="size-4 animate-spin" />
              Searching chat history…
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-10 text-center text-base text-muted">
              Nothing matches “{query}”.
              {/* Naming the limit turns "this app can't find my file" into "this
                  search doesn't cover that", which is actionable. */}
              <span className="mt-1 block text-xs text-faint">
                Chat search covers every transcript, archived ones included. File
                search covers the project's tracked and untracked files; ignored
                files and other drives are in Browse files.
              </span>
            </div>
          ) : (
            items.map((cmd, idx) => (
              <button
                key={cmd.id}
                data-idx={idx}
                onClick={() => runAt(idx)}
                onMouseMove={() => setActive(idx)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  idx === active ? "bg-selected" : "hover:bg-hover",
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
                  <span className="block truncate text-base font-medium text-primary">
                    {cmd.title}
                  </span>
                  {cmd.snippet ? (
                    <span className="block truncate text-xs text-muted">
                      <Highlighted text={cmd.snippet} terms={cmd.terms ?? []} />
                    </span>
                  ) : (
                    cmd.subtitle && (
                      <span className="block truncate text-xs text-muted">{cmd.subtitle}</span>
                    )
                  )}
                </span>
                <span className="flex max-w-[30%] shrink-0 flex-col items-end gap-0.5">
                  <span className="max-w-full truncate text-2xs font-medium uppercase tracking-wide text-faint">
                    {cmd.group}
                  </span>
                  {cmd.meta && <span className="text-2xs text-faint">{cmd.meta}</span>}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-3.5 py-2 cm-hairline-t text-2xs text-faint">
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
          {/* "commands" stopped being true once files joined the list, and a
              count that names the wrong thing is how you conclude the file
              search isn't running when it is. */}
          <ChatSearchStatus progress={chatSearch.progress} />
          <span className="ml-auto shrink-0 cm-mono">
            {footerCount(items.length, fileCommands.length, transcriptCount)}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 commands · 3 files · 8 chats" — only the sections that have rows. */
function footerCount(total: number, files: number, chats: number): string {
  const parts = [plural(total - files - chats, "command")];
  if (files) parts.push(plural(files, "file"));
  if (chats) parts.push(plural(chats, "chat"));
  return parts.join(" · ");
}

/**
 * Where the transcript walk is. While it runs, how far back it has got — what
 * tells you whether to keep waiting for an older chat — and once it stops,
 * why: history exhausted, the row cap, or an error.
 */
function ChatSearchStatus({ progress }: { progress: ChatSearchProgress | null }) {
  if (!progress) return null;
  const { running, daysBack, searched, total, capped, error } = progress;
  let label: string;
  if (error) label = "chat search failed";
  else if (running) {
    label = daysBack ? `searching ${daysBack}d back · ${searched}/${total} chats` : "searching chats…";
  } else if (capped) label = `first ${CHAT_SEARCH_MAX_HITS} chat matches · ${daysBack}d back`;
  else label = `searched all ${plural(total, "chat")}`;
  return (
    <span className="flex min-w-0 items-center gap-1" title={error}>
      {running && <Loader2 className="size-3 shrink-0 animate-spin" />}
      <span className="truncate">{label}</span>
    </span>
  );
}
