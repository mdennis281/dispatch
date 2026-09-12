import { useState } from "react";
import { Search, Settings, GitPullRequest, Blocks, FileCog, FolderGit2 } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { UsageMeter } from "./UsageMeter.js";
import { ResourceMeter } from "./ResourceMeter.js";
import { ConnectionDot } from "./ConnectionDot.js";
import { CommandPalette } from "../command/CommandPalette.js";
import { IconButton } from "../ui/IconButton.js";
import { Kbd } from "../ui/Kbd.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { openOverlay, openAppSettings, openProjectSettings } from "../../stores/view.js";
import { openWorkspace } from "../../stores/workspace.js";
import { useLayout } from "../../stores/layout.js";
import { useWindowControlsOverlay } from "../../lib/windowControls.js";

/**
 * The top bar: a STATUS LINE over an ACTION ROW.
 *
 * ── WHY TWO BANDS ────────────────────────────────────────────────────────────
 *
 * Installed in a Chromium window there is no title bar: the page owns the whole
 * surface and the minimise/maximise/close buttons are painted on top of it. That
 * band has to be left clear, and for a while it held nothing but the logo — 33px
 * of window spent on a picture, above a 52px row with everything crammed into
 * it. Then everything moved INTO the strip, which cleared the band and shrank
 * the header to 34px, but put the whole bar back on one line and cost the larger
 * mark, which cannot fit a 33px strip.
 *
 * Neither is what the band is for. It is ~800px of window the page is allowed to
 * draw in, next to the buttons — so it gets the readings you GLANCE at (is it
 * connected, is the machine coping, how much quota is left), and the row below
 * keeps the things you ACT on (search, the attention queue, the destinations)
 * with room to breathe and the full-size mark back.
 *
 * ── WHAT MAKES THE SPLIT WORK ────────────────────────────────────────────────
 *
 * Only the status line has to care about the overlay at all: the window buttons
 * are painted in the `titlebar-area` band and nowhere else, so the ACTION ROW
 * spans the full window width even in an installed window and needs nothing
 * platform-specific — it is the same row as in a browser tab. That is why the
 * elaborate width ladder this file used to carry is gone: it existed only to fit
 * one row beside the buttons.
 *
 * In a browser tab the status line stays, at the height of a Windows strip,
 * because the split is the design rather than an accommodation: the same
 * readings in the same place whether or not the window has chrome.
 *
 * A PHONE gets neither. `compact` drops the status line and folds its two
 * survivors — the connection dot and usage — back into the single row, which is
 * all ~390px can carry. The overlay is desktop-only, but a desktop window CAN be
 * narrower than 768px, and there the strip is still rendered: it is the only
 * thing left that drags the window.
 */
export function TopBar() {
  const overlay = useWindowControlsOverlay();
  // At phone width the bar has ~390px minus the safe insets to spend, and it was
  // spending 620 — so everything that repeats information goes. What's left is
  // what nothing else in the shell says: the mark, whether we're connected, the
  // palette, and usage.
  const compact = useLayout((s) => s.mode) === "sm";
  const status = overlay || !compact;

  return (
    <header className="flex shrink-0 flex-col border-b border-line bg-surface cm-safe-t">
      {status && (overlay ? <TitleBarStatus /> : <TabStatus />)}
      <ActionRow compact={compact} status={status} />
    </header>
  );
}

/**
 * The status line as the window's title bar.
 *
 * `.cm-titlebar` is the drag region and spans the whole window, so the header's
 * background runs unbroken behind the window controls — Chromium paints those on
 * a slab of `theme_color` (kept in step with `--p-surface`; see stores/theme),
 * and a strip that stopped short of them would put a seam a few pixels in from
 * the corner. `.cm-titlebar-area` is the part we may actually draw in: it starts
 * right of the traffic lights on macOS and stops left of the buttons on Windows,
 * so the readings inside it clear them on both platforms without this code
 * knowing which side they are on.
 *
 * `app-region: drag` buys the whole of a title bar's behaviour, not just moving
 * the window: double-click maximises and restores, right-click opens the system
 * menu, a drag to a screen edge snaps. It also takes every click and hover in
 * the region before the page sees them, so the gauges inside are carved back out
 * as `no-drag` by `.cm-titlebar` in index.css — by element, so that the next
 * reading added here is pressable without its author knowing the rule exists.
 */
function TitleBarStatus() {
  return (
    <div className="cm-titlebar border-b border-line-soft">
      <div className="cm-titlebar-area @container/statusline">
        <StatusRow />
      </div>
    </div>
  );
}

/**
 * The same line in a browser tab, where every pixel of it is ours.
 *
 * `h-8` is a Windows overlay strip at 100% (33px) to the nearest step: the two
 * modes should differ in what the OS paints on them, not in the shape of the
 * app. Still a `statusline` container, so the gauges collapse at the same widths
 * here as they do beside the window buttons.
 */
function TabStatus() {
  return (
    <div className="h-8 shrink-0 border-b border-line-soft @container/statusline">
      <StatusRow />
    </div>
  );
}

/**
 * What the status line carries: the connection, then the machine and the quota.
 *
 * The dot sits at the left where the eye starts, and the gauges are right-
 * aligned — directly above the attention queue and the destination icons, so
 * everything ambient shares one corner and everything you press shares the
 * other.
 *
 * The spacer between them is the WINDOW HANDLE. In an installed window the gaps
 * between these controls are the only thing left to drag the window by, and
 * `min-w-16` keeps a real target open rather than letting it squeeze down to the
 * `gap` on a narrow window. It earns its keep in a tab too: the readings are
 * dense, and crowding them against the dot would make the line read as a
 * toolbar rather than as a status strip.
 */
function StatusRow() {
  return (
    <div className="flex h-full items-center gap-2 pl-1.5 pr-3">
      <ConnectionDot />
      <div aria-hidden className="min-w-16 flex-1 self-stretch" />
      <div className="flex shrink-0 items-center gap-1">
        <ResourceMeter />
        <UsageMeter />
      </div>
    </div>
  );
}

/**
 * Everything the bar acts on. One row, full window width, overlay or not.
 *
 * `min-h-13` rather than `h-13`: with `viewport-fit=cover` and a
 * black-translucent status bar (see index.html) the installed PWA draws under
 * the clock, so the inset — applied as `cm-safe-t` on the header above — has to
 * be added ON TOP of this row's height. A fixed height would have carved the
 * padding out of it and left the controls half under the notch.
 *
 * `pb-2` on top of that: the row was sitting hard against the hairline, so on a
 * phone the mark and the first chat row below it read as one crowded block.
 * Padding only at the BOTTOM, because the top is already spoken for by
 * `cm-safe-t` — adding `pt` there would double the inset on a notched display
 * and leave the bar visibly lopsided on a flat one. 52 − 8 still leaves the 44px
 * touch row intact.
 */
function ActionRow({ compact, status }: { compact: boolean; status: boolean }) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="flex min-h-13 shrink-0 items-center gap-3 px-3 pb-2">
      {/* The live SVG stays transparent here. Desktop and mobile launch icons
          may still need an OS-owned mask or full-bleed canvas, but carrying that
          plate into the app header made the mark look like a raster tile and
          prevented the branches from belonging to the surrounding surface.

          Full size in both modes, and THIS is the row it belongs in: the mark is
          32px and a title bar strip is 33, so the version of this bar that moved
          the identity up there had to cut it to 20px, where it stopped reading as
          the logo at all. */}
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <DispatchMark className="size-8 shrink-0" title="Dispatch" />
        {/* No version here. `v0.1` was a hardcoded stand-in that never moved and
            said nothing about the bundle you're running; the sidebar's build
            stamp does, and the connection card names both halves when they
            disagree, so a third, permanently-wrong number beside the logo is
            worse than none.

            The wordmark drops on a phone: the mark beside it is the same brand,
            at a glance, in a quarter of the width — and on a home-screen PWA the
            app's name is already under the icon you tapped. */}
        {!compact && (
          <span className="text-base font-semibold tracking-tight text-primary">Dispatch</span>
        )}
      </div>

      {/* The connection and usage rejoin this row only when there is no status
          line to hold them. Keyed on the LINE, not on `compact`: a desktop
          window narrowed past 768px is compact and still has a strip, and
          keying this on width drew both of them twice — once up there, once
          down here. */}
      {!status && <ConnectionDot />}

      {/* Command palette — ONE affordance, not three. This box used to sit
          beside a ⌘ icon button that opened the very same palette, on top of
          the ⌘K shortcut the box already advertises. Below `md` the box is the
          thing that doesn't fit, so it collapses to the icon rather than
          vanishing and leaving the palette mouse-unreachable.

          It GROWS now, to 380px. The meters that used to sit at the end of this
          row are a line up, and handing that width to the one control here you
          actually type into beats leaving a hole where they were. */}
      <button
        onClick={() => setPaletteOpen(true)}
        aria-label="Search or run a command"
        className="group hidden h-7 min-w-0 max-w-[380px] flex-1 items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2.5 text-muted transition-colors hover:border-line-strong hover:text-secondary md:flex"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="truncate text-xs">Search or run a command</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-3">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="md:hidden">
        <IconButton tip="Search or run a command (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Search />
        </IconButton>
      </div>

      {/* The four overlay buttons and the attention queue move into the bottom
          nav's ⋯ More sheet on a phone — see layout/BottomNav. They are the
          right things to cut here because every one of them is a destination
          you visit occasionally, and a sheet is a better place for seven
          occasional destinations than a row of unlabelled 24px icons. */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {compact ? (
          !status && <UsageMeter />
        ) : (
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
