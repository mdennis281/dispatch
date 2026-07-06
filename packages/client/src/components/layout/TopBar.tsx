import { useState } from "react";
import { Hexagon, Search, Settings, Command, GitPullRequest, Blocks } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { CommandPalette } from "../command/CommandPalette.js";
import { SettingsPanel } from "../settings/SettingsPanel.js";
import { requestOpenProjectPrs } from "../prs/projectPrsBus.js";
import { requestOpenMcpCatalog } from "../mcp/mcpCatalogBus.js";
import { IconButton } from "../ui/IconButton.js";
import { Kbd } from "../ui/Kbd.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { useConnection, type ConnState } from "../../stores/connection.js";
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      {/* mark */}
      <div className="flex items-center gap-2 pr-1">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
          <Hexagon />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-primary">claude-manager</span>
        <span className="cm-mono !text-[9.5px] text-faint">v0.1</span>
      </div>

      {/* connection */}
      <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-1">
        <StatusDot tone={c.tone} pulse={c.pulse} size={6} />
        <span className={cn("text-[11px] font-medium", c.text)}>{c.label}</span>
      </div>

      {/* command palette hint */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="group ml-2 hidden items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1 text-muted transition-colors hover:border-line-strong hover:text-secondary md:flex"
      >
        <Search className="size-3.5" />
        <span className="text-[11.5px]">Search or run a command</span>
        <span className="ml-6 flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <AttentionPopover />
        <IconButton tip="MCP tools" onClick={requestOpenMcpCatalog}>
          <Blocks />
        </IconButton>
        <IconButton tip="Open pull requests" onClick={requestOpenProjectPrs}>
          <GitPullRequest />
        </IconButton>
        <IconButton tip="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Command />
        </IconButton>
        <IconButton tip="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
