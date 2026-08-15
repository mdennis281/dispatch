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
import { useLayout } from "../../stores/layout.js";
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

  // At phone width the bar has ~390px minus the safe insets to spend, and it was
  // spending 620 — so everything that repeats information goes. What's left is
  // what nothing else in the shell says: the mark, whether we're connected, the
  // palette, and usage.
  const compact = useLayout((s) => s.mode) === "sm";

  // `min-h-13` rather than `h-13`, plus `cm-safe-t`: with `viewport-fit=cover`
  // and a black-translucent status bar (see index.html) the installed PWA draws
  // under the clock, so the inset has to be added ON TOP of the bar's height — a
  // fixed height would have carved the padding out of it and left the controls
  // half under the notch.
  //
  // `pb-2` on top of that: the row was sitting hard against the hairline, so on
  // a phone the mark and the first chat row below it read as one crowded block.
  // Padding only at the BOTTOM, because the top is already spoken for by
  // `cm-safe-t` — adding `pt` there would double the inset on a notched display
  // and leave the bar visibly lopsided on a flat one. 52 − 8 still leaves the
  // 44px touch row intact.
  return (
    <header className="flex min-h-13 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 pb-2 cm-safe-t">
      {/* mark — the real app icon, not a stand-in glyph: the thing in the
          top-left should be the thing you launched, matching the tab favicon
          and the taskbar icon exactly (see ui/DispatchMark).

          No ring. The mark already draws its own rounded plate, so an amber
          ring around it was a second border on the same edge — at 24px it read
          as a badge someone had outlined rather than as the app icon, and it
          didn't appear on the favicon or the installed icon it's supposed to
          match. Dropping it also frees the 2px it was eating, so the mark goes
          to 32px: same footprint in the bar, a bigger actual logo. */}
      <div className="flex items-center gap-2 pr-1">
        <DispatchMark platedTheme className="size-8 shrink-0" title="Dispatch" />
        {/* No version here. `v0.1` was a hardcoded stand-in that never moved and
            said nothing about the bundle you're running; the sidebar's build
            stamp does, so a second, permanently-wrong number next to the logo is
            worse than none.

            The wordmark drops on a phone: the mark beside it is the same brand,
            at a glance, in a quarter of the width — and on a home-screen PWA the
            app's name is already under the icon you tapped. */}
        {!compact && (
          <span className="text-base font-semibold tracking-tight text-primary">Dispatch</span>
        )}
      </div>

      {/* connection — the dot alone on a phone. `CONN_META` already carries the
          tone, so the label is a second encoding of the same fact, and it's the
          one that costs 90px. `title`/`aria-label` keep the word available to a
          long-press and to a screen reader. */}
      <div
        className={cn(
          "flex items-center gap-1.5",
          !compact && "rounded-md border border-line bg-panel-2/60 px-2 py-1",
        )}
        title={compact ? c.label : undefined}
        aria-label={compact ? c.label : undefined}
      >
        <StatusDot tone={c.tone} pulse={c.pulse} size={6} />
        {!compact && <span className={cn("text-xs font-medium", c.text)}>{c.label}</span>}
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
        <span className="text-xs">Search or run a command</span>
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

      {/* The four overlay buttons and the attention queue move into the bottom
          nav's ⋯ More sheet on a phone — see layout/BottomNav. They are the
          right things to cut here because every one of them is a destination
          you visit occasionally, and a sheet is a better place for seven
          occasional destinations than a row of unlabelled 24px icons. */}
      <div className="ml-auto flex items-center gap-1.5">
        <UsageMeter />
        {!compact && (
          <>
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
          </>
        )}
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </header>
  );
}
