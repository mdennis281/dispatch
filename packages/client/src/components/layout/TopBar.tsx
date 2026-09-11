import { useState } from "react";
import { Search, Settings, GitPullRequest, Blocks, FileCog, FolderGit2 } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { UsageMeter } from "./UsageMeter.js";
import { ResourceMeter } from "./ResourceMeter.js";
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
 * The top bar. A row under the browser's chrome in a tab; the title bar itself
 * in an installed window.
 *
 * Installed in a Chromium window there is no title bar at all: the page owns the
 * whole surface and the minimise/maximise/close buttons are painted on top of it.
 * The first answer to that was a second row — a drag strip exactly as tall as
 * those buttons, holding the mark and the wordmark, stacked above this bar. It
 * cleared the buttons, but it spent 85px of every window on a header whose top
 * 33px carried a 20px logo and nothing you could press, beside ~800px of empty
 * strip. So the bar now moves INTO the strip, the way VS Code's and Teams' title
 * bars carry their own controls: one row, as tall as the window buttons, and the
 * space between its controls is what you drag the window by.
 */
export function TopBar() {
  const overlay = useWindowControlsOverlay();

  return (
    <header className="flex shrink-0 flex-col border-b border-line bg-surface cm-safe-t">
      {overlay ? <TitleBar /> : <BarRow titleBar={false} />}
    </header>
  );
}

/**
 * The bar as a window title bar.
 *
 * `.cm-titlebar` is the drag region and spans the whole window, so the header's
 * background runs unbroken behind the window controls. `.cm-titlebar-area` is
 * clipped to the `titlebar-area-*` rect the UA says is ours — right of the
 * traffic lights on macOS, left of the buttons on Windows — so the row inside it
 * is clear of them on both without knowing which side they are on.
 *
 * That box is also the `titlebar` CONTAINER the row sizes itself against — see
 * `BarRow` for why it can't be the viewport.
 *
 * `app-region: drag` gives back everything a real title bar does, not just
 * moving the window — double-click maximises and restores, right-click opens the
 * system window menu, dragging to an edge snaps. It also eats every click and
 * hover over the region, so the controls in the row are carved back out as
 * `no-drag` by `.cm-titlebar` in index.css rather than one by one here, where
 * the next control added to the row would forget.
 */
function TitleBar() {
  return (
    <div className="cm-titlebar">
      <div className="cm-titlebar-area @container/titlebar">
        <BarRow titleBar />
      </div>
    </div>
  );
}

/**
 * The title bar's width steps that move with the connection.
 *
 * A HEALTHY connection gives up its word early — its green dot already says it.
 * An unhealthy one keeps it until the bar is nearly phone-narrow: "Reconnecting…"
 * and "Offline" are the states this indicator exists for, the ones that explain
 * why nothing is updating, and a pulsing amber dot on its own is easy to read as
 * decor. That word holds ~100px, so while it is up the two steps that give room
 * back — search box to icon, resource meter out — come that much sooner.
 * Without that, "Reconnecting…" in a 1095px window truncated the search box to
 * a lone "S", and at 800px pushed Settings off the clipped end of the bar.
 *
 * Whole literal class names, never assembled from a shared prefix: Tailwind
 * finds classes by scanning source text, and `` `${prefix}:hidden` `` is a class
 * it never sees and so never emits.
 */
const STEPS = {
  healthy: {
    connPill:
      "@max-[68rem]/titlebar:border-transparent @max-[68rem]/titlebar:bg-transparent @max-[68rem]/titlebar:px-1",
    connWord: "@max-[68rem]/titlebar:sr-only",
    searchBox: "@min-[52rem]/titlebar:flex",
    searchIcon: "@min-[52rem]/titlebar:hidden",
    meter: "@max-[40rem]/titlebar:hidden",
  },
  unhealthy: {
    connPill:
      "@max-[40rem]/titlebar:border-transparent @max-[40rem]/titlebar:bg-transparent @max-[40rem]/titlebar:px-1",
    connWord: "@max-[40rem]/titlebar:sr-only",
    searchBox: "@min-[68rem]/titlebar:flex",
    searchIcon: "@min-[68rem]/titlebar:hidden",
    meter: "@max-[48rem]/titlebar:hidden",
  },
} as const;

/**
 * Everything the bar actually does, framed either as a free-standing row (tab)
 * or as the contents of the window's title bar.
 *
 * `titleBar` decides the frame (the strip's height and a guaranteed drag gap,
 * instead of a 52px row), the mark's size, and whether the search box collapses
 * on a viewport breakpoint or on the title bar's width. The rest is the same
 * markup in both.
 *
 * In the title bar the row gives things up as the TITLE BAR narrows, through
 * `@…/titlebar` container variants, rather than on viewport breakpoints —
 * because the window controls take a slab of the strip whose width is nobody's
 * constant. It depends on the platform, the DPI, and how many of Chromium's own
 * buttons sit beside the system three: the overlay toggle, extensions and the
 * app menu put it at ~260px on Windows at 100%, against 138 for
 * minimise/maximise/close alone. `.cm-titlebar-area` is exactly the width left
 * after all of that, so a container query against it answers "does this fit"
 * without modelling any of it. Outside that container the variants match
 * nothing, which is what leaves the tab layout exactly as it was.
 *
 * Least information goes first, each step measured to leave the drag gap at
 * ~80px or more across the width it covers (the title bar is 833px in a 1095px
 * window on Windows at 100%):
 *   - below 72rem, the wordmark — the OS already names the window;
 *   - below 68rem, the long search placeholder (⌘K is still printed on the box);
 *   - below 56rem, the resource meter's bars (ResourceMeter) — each repeats the
 *     figure printed beside it;
 *   - below 52rem, the attention label (AttentionPopover; the glyph and badge
 *     stay);
 *   - and the connection's word, the search box and the resource meter at the
 *     widths in `STEPS`, which depend on whether the connection is healthy.
 * Past the last step the search box truncates, and past THAT the area clips,
 * so a control can end up cut short but never underneath the window buttons.
 */
function BarRow({ titleBar }: { titleBar: boolean }) {
  const conn = useConnection((s) => s.state);
  const c = CONN_META[conn];

  const [paletteOpen, setPaletteOpen] = useState(false);

  // At phone width the bar has ~390px minus the safe insets to spend, and it was
  // spending 620 — so everything that repeats information goes. What's left is
  // what nothing else in the shell says: the mark, whether we're connected, the
  // palette, and usage.
  const compact = useLayout((s) => s.mode) === "sm";

  const steps = STEPS[conn === "open" ? "healthy" : "unhealthy"];

  return (
    <div
      className={cn(
        "flex shrink-0 items-center",
        titleBar
          ? // `h-full` of the strip. The right padding is the gap before the
            // window controls, which on Windows open with Chromium's own overlay
            // toggle — they want a little air, not a wall.
            "h-full gap-2 pl-3 pr-2"
          : // `min-h-13` rather than `h-13`: with `viewport-fit=cover` and a
            // black-translucent status bar (see index.html) the installed PWA
            // draws under the clock, so the inset — applied as `cm-safe-t` on the
            // header above — has to be added ON TOP of this row's height. A fixed
            // height would have carved the padding out of it and left the
            // controls half under the notch.
            //
            // `pb-2` on top of that: the row was sitting hard against the
            // hairline, so on a phone the mark and the first chat row below it
            // read as one crowded block. Padding only at the BOTTOM, because the
            // top is already spoken for by `cm-safe-t` — adding `pt` there would
            // double the inset on a notched display and leave the bar visibly
            // lopsided on a flat one. 52 − 8 still leaves the 44px touch row.
            "min-h-13 gap-3 px-3 pb-2",
      )}
    >
      {/* The live SVG stays transparent here. Desktop and mobile launch icons
          may still need an OS-owned mask or full-bleed canvas, but carrying that
          plate into the app header made the mark look like a raster tile and
          prevented the branches from belonging to the surrounding surface.

          Title-bar sized in the title bar: the strip is ~33px, and the tab row's
          32px mark would touch both edges of it. */}
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <DispatchMark className={cn("shrink-0", titleBar ? "size-5" : "size-8")} title="Dispatch" />
        {/* No version here. `v0.1` was a hardcoded stand-in that never moved and
            said nothing about the bundle you're running; the sidebar's build
            stamp does, so a second, permanently-wrong number next to the logo is
            worse than none.

            The wordmark drops on a phone: the mark beside it is the same brand,
            at a glance, in a quarter of the width — and on a home-screen PWA the
            app's name is already under the icon you tapped. */}
        {!compact && (
          <span
            className={cn(
              "select-none font-semibold tracking-tight",
              titleBar
                ? "text-xs text-secondary @max-[72rem]/titlebar:hidden"
                : "text-base text-primary",
            )}
          >
            Dispatch
          </span>
        )}
      </div>

      {/* connection — the dot alone on a phone. `CONN_META` already carries the
          tone, so the label is a second encoding of the same fact, and it's the
          one that costs 90px. `title`/`aria-label` keep the word available to a
          long-press and to a screen reader.

          A narrow title bar QUIETS the pill rather than removing the word: it
          goes to `sr-only`, so it is still what a screen reader hears, and the
          capsule goes transparent so a lone dot isn't sitting in an empty one.
          `cm-no-drag` because the `title` is then the only way to read the word
          with a mouse, and a drag region never delivers the hover that shows it. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5",
          !compact && "h-6 rounded-md border border-line bg-panel-2/60 px-2",
          titleBar && `cm-no-drag ${steps.connPill}`,
        )}
        title={compact || titleBar ? c.label : undefined}
        aria-label={compact ? c.label : undefined}
      >
        <StatusDot tone={c.tone} pulse={c.pulse} size={6} />
        {!compact && (
          <span className={cn("text-xs font-medium", c.text, titleBar && steps.connWord)}>
            {c.label}
          </span>
        )}
      </div>

      {/* Command palette — ONE affordance, not three. This box used to sit
          beside a ⌘ icon button that opened the very same palette, on top of
          the ⌘K shortcut the box already advertises. When the box is the thing
          that doesn't fit, it collapses to the icon rather than vanishing and
          leaving the palette mouse-unreachable — at `md` in a tab, and at the
          title bar's own width in a window. */}
      <button
        onClick={() => setPaletteOpen(true)}
        aria-label="Search or run a command"
        className={cn(
          "group ml-2 hidden h-6 min-w-0 items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 text-muted transition-colors hover:border-line-strong hover:text-secondary",
          titleBar ? steps.searchBox : "md:flex",
        )}
      >
        <Search className="size-3.5 shrink-0" />
        <span className="truncate text-xs">
          Search<span className="@max-[68rem]/titlebar:hidden"> or run a command</span>
        </span>
        <span className="ml-6 flex shrink-0 items-center gap-0.5 @max-[68rem]/titlebar:ml-3">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className={cn("ml-2", titleBar ? steps.searchIcon : "md:hidden")}>
        <IconButton tip="Search or run a command (⌘K)" onClick={() => setPaletteOpen(true)}>
          <Search />
        </IconButton>
      </div>

      {/* The drag handle. Only the title bar needs one spelled out: there the
          gaps between controls ARE the window's grab area, and without a floor a
          row that has run out of room squeezes them down to the 8px `gap` — a
          title bar you have to hunt for a pixel of. `min-w-16` holds a real
          target open; the ladder above is sized so the row sheds controls long
          before it leans on this. */}
      {titleBar && <div aria-hidden className="min-w-16 flex-1 self-stretch" />}

      {/* The four overlay buttons and the attention queue move into the bottom
          nav's ⋯ More sheet on a phone — see layout/BottomNav. They are the
          right things to cut here because every one of them is a destination
          you visit occasionally, and a sheet is a better place for seven
          occasional destinations than a row of unlabelled 24px icons. */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* Hidden on a phone with the rest of this row's occasional controls:
            it is a glance for someone watching a build, and the bottom nav's
            More sheet is where that reader already goes.

            `contents`, so the wrapper that lets a narrow title bar hide it is not
            a box of its own: the meter renders nothing until its first reading,
            and an empty flex item there would still take a `gap` either side. */}
        {!compact && (
          <div className={cn("contents", titleBar && steps.meter)}>
            <ResourceMeter />
          </div>
        )}
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
