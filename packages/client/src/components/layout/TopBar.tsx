import { useState } from "react";
import { Search, Settings, GitPullRequest, Blocks, FileCog } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { UsageMeter } from "./UsageMeter.js";
import { CommandPalette } from "../command/CommandPalette.js";
import { IconButton } from "../ui/IconButton.js";
import { Kbd } from "../ui/Kbd.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { useConnection, type ConnState } from "../../stores/connection.js";
import { openOverlay } from "../../stores/view.js";
import { cn } from "../../lib/cn.js";

const CONN_META: Record<ConnState, { tone: DotTone; label: string; pulse: boolean; text: string }> = {
  open: { tone: "success", label: "Connected", pulse: false, text: "text-secondary" },
  connecting: { tone: "warn", label: "Connecting…", pulse: true, text: "text-warn" },
  reconnecting: { tone: "warn", label: "Reconnecting…", pulse: true, text: "text-warn" },
  closed: { tone: "muted", label: "Offline", pulse: false, text: "text-muted" },
};

export function TopBar() {
  const conn = useConnection((s) => s.state);
  const c = CONN_META[conn];

  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      {/* mark — the real app icon, not a stand-in glyph: the thing in the
          top-left should be the thing you launched, matching the tab favicon
          and the taskbar icon exactly (see ui/DispatchMark). */}
      <div className="flex items-center gap-2 pr-1">
        <DispatchMark
          platedTheme
          className="size-6 shrink-0 rounded-md ring-1 ring-accent-line"
          title="Dispatch"
        />
        <span className="text-[13px] font-semibold tracking-tight text-primary">Dispatch</span>
        <span className="cm-mono !text-[9.5px] text-faint">v0.1</span>
      </div>

      {/* connection */}
      <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-1">
        <StatusDot tone={c.tone} pulse={c.pulse} size={6} />
        <span className={cn("text-[11px] font-medium", c.text)}>{c.label}</span>
      </div>

      {/* Command palette — ONE affordance, not three. This box used to sit
          beside a ⌘ icon button that opened the very same palette, on top of
          the ⌘K shortcut the box already advertises. Below `md` the box is the
          thing that doesn't fit, so it collapses to the icon rather than
          vanishing and leaving the palette mouse-unreachable. */}
      <button
        onClick={() => setPaletteOpen(true)}
        aria-label="Search or run a command"
        className="group ml-2 hidden items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1 text-muted transition-colors hover:border-line-strong hover:text-secondary md:flex"
      >
        <Search className="size-3.5" />
        <span className="text-[11.5px]">Search or run a command</span>
        <span className="ml-6 flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ml-2 md:hidden">
        <IconButton tip="Search or run a command (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Search />
        </IconButton>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <UsageMeter />
        <AttentionPopover />
        <IconButton tip="Project config" onClick={() => openOverlay("config")}>
          <FileCog />
        </IconButton>
        <IconButton tip="MCP tools" onClick={() => openOverlay("mcp")}>
          <Blocks />
        </IconButton>
        <IconButton tip="Open pull requests" onClick={() => openOverlay("prs")}>
          <GitPullRequest />
        </IconButton>
        <IconButton tip="Settings" onClick={() => openOverlay("settings")}>
          <Settings />
        </IconButton>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </header>
  );
}
