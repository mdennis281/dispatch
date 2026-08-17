import { useState } from "react";
import { Search, Settings, GitPullRequest, Blocks, FileCog, FolderGit2 } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { UsageMeter } from "./UsageMeter.js";
import { CommandPalette } from "../command/CommandPalette.js";
import { IconButton } from "../ui/IconButton.js";
import { Kbd } from "../ui/Kbd.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { useConnection, type ConnState } from "../../stores/connection.js";
import { openOverlay, openAppSettings, openProjectSettings } from "../../stores/view.js";
import { openWorkspace } from "../../stores/workspace.js";
import { useLayout } from "../../stores/layout.js";
import { useWindowControlsOverlay } from "../../lib/windowControls.js";
import { cn } from "../../lib/cn.js";

const CONN_META: Record<ConnState, { tone: DotTone; label: string; pulse: boolean; text: string }> = {
  open: { tone: "success", label: "Connected", pulse: false, text: "text-secondary" },
  connecting: { tone: "warn", label: "Connecting…", pulse: true, text: "text-warn" },
  reconnecting: { tone: "warn", label: "Reconnecting…", pulse: true, text: "text-warn" },
  closed: { tone: "muted", label: "Offline", pulse: false, text: "text-muted" },
};

/**
 * The top bar, which is one row normally and two when it has to be a title bar.
 *
 * Installed in a Chromium window there is no title bar at all: the page owns the
 * whole surface and the minimise/maximise/close buttons are painted on top of it.
 * That is what put a close button through the right-hand end of this row. So when
 * the overlay is up the bar grows a strip above itself that is exactly as tall as
 * those buttons — draggable, holding nothing but the app's identity — and the row
 * below it is then clear of them without knowing anything about where they are.
 *
 * `flex-col` here with the horizontal padding on the ROW rather than on this
 * element: the strip has to reach the window's corners (see `.cm-titlebar`), and
 * a `px-3` up here would inset it by 12px at each end — 12px of the window's own
 * top-left corner that no longer drags it.
 */
export function TopBar() {
  const overlay = useWindowControlsOverlay();

  return (
    <header className="flex shrink-0 flex-col border-b border-line bg-surface cm-safe-t">
      {overlay && <TitleBar />}
      <MainRow overlay={overlay} />
    </header>
  );
}

/**
 * Everything the bar actually does. Split out so the drag strip above it can be a
 * sibling rather than a first child, which is what lets that strip be full-bleed
 * while this row keeps its padding.
 *
 * `overlay` only reaches here to suppress the mark and wordmark, which have moved
 * up into the strip.
 */
function MainRow({ overlay }: { overlay: boolean }) {
  const conn = useConnection((s) => s.state);
  const c = CONN_META[conn];

  const [paletteOpen, setPaletteOpen] = useState(false);

  // At phone width the bar has ~390px minus the safe insets to spend, and it was
  // spending 620 — so everything that repeats information goes. What's left is
  // what nothing else in the shell says: the mark, whether we're connected, the
  // palette, and usage.
  const compact = useLayout((s) => s.mode) === "sm";

  // `min-h-13` rather than `h-13`: with `viewport-fit=cover` and a
  // black-translucent status bar (see index.html) the installed PWA draws under
  // the clock, so the inset — applied as `cm-safe-t` on the header above — has to
  // be added ON TOP of this row's height. A fixed height would have carved the
  // padding out of it and left the controls half under the notch.
  //
  // `pb-2` on top of that: the row was sitting hard against the hairline, so on
  // a phone the mark and the first chat row below it read as one crowded block.
  // Padding only at the BOTTOM, because the top is already spoken for by
  // `cm-safe-t` — adding `pt` there would double the inset on a notched display
  // and leave the bar visibly lopsided on a flat one. 52 − 8 still leaves the
  // 44px touch row intact.
  return (
    <div className="flex min-h-13 shrink-0 items-center gap-3 px-3 pb-2">
      {/* mark — the real app icon, not a stand-in glyph: the thing in the
          top-left should be the thing you launched, matching the tab favicon
          and the taskbar icon exactly (see ui/DispatchMark).

          No ring. The mark already draws its own rounded plate, so an amber
          ring around it was a second border on the same edge — at 24px it read
          as a badge someone had outlined rather than as the app icon, and it
          didn't appear on the favicon or the installed icon it's supposed to
          match. Dropping it also frees the 2px it was eating, so the mark goes
          to 32px: same footprint in the bar, a bigger actual logo.

          Gone when there is a drag strip above, because the identity moved up
          into it — the way VS Code and Teams put theirs in the title bar. Two app
          icons in one corner, or a wordmark repeated directly under itself, is
          what would make the taller header read as a mistake. */}
      {!overlay && (
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
      )}

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
            {/* Two of these five are now full PAGES rather than overlays (see
                stores/view) — they'd outgrown a dialog. They keep their slot in
                this row because from here they're the same gesture: the thing
                you were doing stays where it is, and you come back to it. */}
            <IconButton
              tip="Workspace — worktrees, terminals, PRs"
              onClick={() => openOverlay("workspace")}
            >
              <FolderGit2 />
            </IconButton>
            <IconButton tip="Project config" onClick={() => openProjectSettings()}>
              <FileCog />
            </IconButton>
            <IconButton tip="MCP tools" onClick={() => openOverlay("mcp")}>
              <Blocks />
            </IconButton>
            <IconButton tip="Pull requests" onClick={() => openWorkspace("prs")}>
              <GitPullRequest />
            </IconButton>
            <IconButton tip="Settings" onClick={() => openAppSettings()}>
              <Settings />
            </IconButton>
          </>
        )}
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/**
 * The row that only exists to be grabbed.
 *
 * With the window controls overlay there is nothing left to drag a window by:
 * the title bar is gone and the only chrome remaining is four buttons in the
 * corner. `app-region: drag` on this strip gives it back — and gives back the
 * rest of the title bar's behaviour with it, since the OS handles a drag region
 * the same way it handles its own bar: double-click maximises and restores,
 * right-click opens the system window menu, and dragging to an edge snaps.
 *
 * The height is the overlay's own, read from `env(titlebar-area-height)`, so the
 * row ends exactly where the buttons do and the row below is clear of them
 * without knowing anything about them. It is 0 when there is no overlay, which is
 * why this component is never rendered then — a `border-b` on a 0px box would
 * still draw a stray hairline.
 *
 * Nothing in here is interactive, and that is a constraint rather than a
 * shortage of ideas: draggability inherits to every descendant and swallows the
 * clicks and text selection it inherits over, so a button here would need an
 * explicit `app-region: no-drag` and would carve a hole in the drag target at the
 * one width where the target is already thin.
 */
function TitleBar() {
  return (
    <div className="cm-titlebar">
      {/* Clipped to the area the UA says is ours — on macOS that starts ~78px in,
          because the buttons are on the LEFT there. `pl-3` inside it rather than
          on the strip so the mark lines up with the row below on Windows without
          being pushed off the far side of the controls on a Mac. */}
      <div className="cm-titlebar-area flex items-center gap-2 pl-3">
        <DispatchMark platedTheme className="size-5 shrink-0" title="Dispatch" />
        {/* `select-none` is belt and braces — a drag region already suppresses
            selection — but it also covers the moment before the property applies
            and the case where only the prefixed spelling is understood. */}
        <span className="select-none truncate text-xs font-semibold tracking-tight text-secondary">
          Dispatch
        </span>
      </div>
    </div>
  );
}
