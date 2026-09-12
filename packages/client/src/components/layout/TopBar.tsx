import { useState } from "react";
import { Search, Settings, GitPullRequest, Blocks, FileCog, FolderGit2 } from "lucide-react";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { UsageMeter } from "./UsageMeter.js";
import { ResourceMeter } from "./ResourceMeter.js";
import { BrandLockup } from "./BrandLockup.js";
import { GaugeSep } from "./Gauge.js";
import { CommandPalette } from "../command/CommandPalette.js";
import { IconButton } from "../ui/IconButton.js";
import { openOverlay, openAppSettings, openProjectSettings } from "../../stores/view.js";
import { openWorkspace } from "../../stores/workspace.js";
import { useLayout } from "../../stores/layout.js";
import { useWindowControlsOverlay } from "../../lib/windowControls.js";

/**
 * The top bar. Two shapes, and they are deliberately NOT the same height.
 *
 * ── THE INSTALLED WINDOW: A TWO-LINE TITLE BAR ───────────────────────────────
 *
 * With the window controls overlay up there is no title bar: the page owns the
 * whole surface and the OS paints its buttons into the top-right corner of it.
 * That is height the window hands over for free, and the bar spends it — as ONE
 * two-line surface rather than a strip stacked on a toolbar:
 *
 *   [mark]                 CPU ╱╲╱╲ 37%   5H ▬▬▬▭ 42%          — ☐ ✕
 *   [    ]  Dispatch ●     MEM ‾‾‾‾ 74%   [Attention 2]    ⌕ ▫▫▫▫▫
 *
 * (the lockup is centred across both lines)
 *
 * Things that deserve height span both lines: the lockup at a 48px mark, and
 * the machine's readings, stacked so memory gets the chart CPU has. Things one
 * line tall pair up — usage over the attention queue, both "what needs me" — and
 * the icons take line two at the right, directly under the window buttons, which
 * is the one place a two-line element can't go.
 *
 * It was two separate bands before this: a status line holding a lone
 * connection dot and the gauges, over an action row holding the mark and a
 * 380px search box. That used the height without using the SPACE — a dot with
 * a strip to itself, a mark boxed into the lower line, and the widest thing in
 * the bar a fake text field whose only behaviour was opening a modal.
 *
 * ── EVERYWHERE ELSE: ONE SLIM ROW ────────────────────────────────────────────
 *
 * A browser tab (which is how Dispatch is normally reached — through a proxy)
 * already spends its top on the browser's own chrome. There the extra line is
 * not free, it is taken from the transcript, so the bar is a single 44px row
 * with the same parts inline. Consistency between the two was never the point:
 * the overlay is an excuse to use more room, and its absence is a reason to use
 * less.
 *
 * A PHONE keeps the single row at touch height and drops to the essentials —
 * the destinations live in the bottom nav's More sheet there.
 */
export function TopBar() {
  const overlay = useWindowControlsOverlay();
  // At phone width the bar has ~390px minus the safe insets to spend, so
  // everything that repeats information goes. What's left is what nothing else
  // in the shell says: the mark and its connection, the palette, and usage.
  const compact = useLayout((s) => s.mode) === "sm";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = () => setPaletteOpen(true);

  return (
    <>
      {overlay ? (
        <TitleBar compact={compact} onSearch={openPalette} />
      ) : (
        <SlimBar compact={compact} onSearch={openPalette} />
      )}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}

interface BarProps {
  compact: boolean;
  onSearch: () => void;
}

/**
 * The installed window's bar: one drag region, two lines tall.
 *
 * `.cm-titlebar` makes the whole header the window's handle, with every control
 * carved back out as `no-drag` by element (index.css). `.cm-topbar-tall` sizes
 * the two lines off the OS band. The spacer is what you actually grab: it keeps
 * `min-w-16` so a narrow window still has something to drag by.
 *
 * The readings collapse by CONTAINER width, CPU/memory first: usage is the
 * figure you act on (stop, or switch provider), and the machine is a glance. The
 * attention queue never collapses on a desktop — it is the one thing here that
 * is somebody waiting on you. Breakpoints are the widths at which the next group
 * would otherwise push the icon column, which never shrinks below the window
 * buttons, off the edge.
 */
function TitleBar({ compact, onSearch }: BarProps) {
  return (
    <header className="cm-titlebar cm-topbar-tall @container/topbar flex shrink-0 overflow-hidden border-b border-line bg-surface">
      <BrandLockup size="tall" />
      <div aria-hidden className="min-w-16 flex-1" />
      <div className="flex shrink-0 @max-[57rem]/topbar:hidden">
        <ResourceMeter layout="stacked" />
        <GaugeSep layout="stacked" />
      </div>
      <div className="flex shrink-0 flex-col">
        <div className="flex h-(--tb-l1) @max-[45rem]/topbar:hidden">
          <UsageMeter layout="stacked" />
        </div>
        {!compact && (
          // `pl-1.5` lines the pill's border up under the usage label rather
          // than under the hover fill's edge.
          <div className="flex flex-1 items-center pl-1.5">
            <AttentionPopover />
          </div>
        )}
      </div>
      <div className="cm-topbar-slab flex shrink-0 flex-col pr-3">
        <div aria-hidden className="h-(--tb-l1)" />
        <div className="flex flex-1 items-center justify-end">
          <Actions compact={compact} onSearch={onSearch} attention={false} />
        </div>
      </div>
    </header>
  );
}

/**
 * The bar in a browser tab (and a standalone window with no overlay): one row.
 *
 * `h-11` on a desktop, where the browser's own chrome is already above it and
 * every pixel here comes out of the transcript. On a phone the row keeps
 * `min-h-13 pb-2` — a 44px touch row with air under it — and `cm-safe-t` on
 * the header adds the notch inset ON TOP rather than carving it out of the row.
 */
function SlimBar({ compact, onSearch }: BarProps) {
  return (
    <header className="@container/topbar flex shrink-0 flex-col border-b border-line bg-surface cm-safe-t">
      <div
        className={
          compact
            ? "flex min-h-13 items-center gap-2 px-3 pb-2"
            : "flex h-11 items-center gap-3 px-3"
        }
      >
        <BrandLockup size={compact ? "mark" : "row"} />
        <div aria-hidden className="min-w-0 flex-1" />
        {!compact && (
          <div className="flex items-center @max-[50rem]/topbar:hidden">
            <ResourceMeter layout="inline" />
            <GaugeSep layout="inline" />
          </div>
        )}
        <UsageMeter layout="inline" />
        <Actions compact={compact} onSearch={onSearch} attention={!compact} />
      </div>
    </header>
  );
}

/**
 * Everything the bar acts on.
 *
 * The palette is an ICON. It was a 380px box styled as a search field, which
 * made it the widest thing in the bar — and it was never a field: clicking it
 * opened the palette modal, which has its own input. A control dressed as
 * something it isn't, at that size, is the worst trade in the bar. ⌘K is in its
 * tooltip.
 *
 * The attention queue leads the icons in a single row; in the title bar it has a
 * line of its own under usage instead. On a phone it and the destinations move
 * into the bottom nav's More sheet (layout/BottomNav): seven occasional destinations fit a sheet
 * better than a row of unlabelled 24px icons.
 */
function Actions({ compact, onSearch, attention }: BarProps & { attention: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {attention && <AttentionPopover />}
      <IconButton
        tip="Search or run a command (⌘K)"
        onClick={onSearch}
        className={attention ? "ml-1.5" : undefined}
      >
        <Search />
      </IconButton>
      {!compact && (
        <>
          {/* Two of these five are full PAGES rather than overlays (see
              stores/view). They keep their slot here because from the bar
              they're the same gesture: what you were doing stays put, and you
              come back to it. */}
          <IconButton tip="Workspace — worktrees, terminals, PRs" onClick={() => openOverlay("workspace")}>
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
  );
}
