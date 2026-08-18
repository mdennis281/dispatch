import { useEffect, useState, type ReactNode } from "react";
import {
  BarChart3,
  MessageSquare,
  Ship,
  Play,
  MoreHorizontal,
  Brain,
  FolderOpen,
  GitBranch,
  Settings,
  Blocks,
  FileCog,
  GitPullRequest,
  Ruler,
} from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { Drawer } from "./Drawer.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Chip.js";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { usePanelCounts } from "../panels/usePanelCounts.js";
import { useLayout, dismissLeftDrawer, type Pane } from "../../stores/layout.js";
import { useView, openOverlay, type AppView } from "../../stores/view.js";
import { openWorkspace } from "../../stores/workspace.js";
import { useAttention } from "../../stores/attention.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useProjects } from "../../stores/projects.js";
import { useGitChangeCount } from "../../stores/git.js";
import { useViewport } from "../../stores/viewport.js";
import { currentSlot, chatsAction } from "./navState.js";
import { LAYER } from "../../lib/layers.js";
import { cn } from "../../lib/cn.js";

/**
 * ONE bar, not two.
 *
 * The obvious mobile layout is a pane switcher plus a separate drawer handle,
 * and it's wrong: two bars competing to answer "where am I" answer it twice and
 * agree never.
 *
 * The same argument applies inside the strip, which is why there is no longer a
 * ☰ slot beside a Chat slot. Two adjacent controls both labelled for the chat
 * surface is the two-bar mistake at slot scale: one went to the transcript, the
 * other opened the list of transcripts, and neither was named in a way that told
 * you which. They are one **Chats** slot now, whose press means "get me back to
 * my chat" from anywhere else and "show me the list" once you're already there —
 * see `chatsAction` in navState.
 *
 * Which slot reads as selected is likewise not decided here: `currentSlot` owns
 * it, so the answer is one function of the whole shell rather than four ternaries
 * that could each be right on their own and wrong together. Every slot can be
 * current, including More — a menu you can't tell is open is a menu you press
 * twice.
 *
 * The Ship / Run slots are `RightPanel`'s own two `PanelGroup`s with their
 * rolled-up badges (see panels/usePanelCounts), not a new taxonomy. The five
 * tabs stay exactly where they are — as the labelled `<Tabs>` strip at the top
 * of the panel — so the nav is a coarse switch and the strip is the fine one.
 */

/** Slot height. 52px clears the 44px minimum touch target with room for a label. */
function NavSlot({
  icon,
  label,
  count,
  current,
  expanded,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** Selected. See `currentSlot` — at most one slot in the strip is ever true. */
  current?: boolean;
  /**
   * For the slot that owns a sheet: whether that sheet is open right now.
   *
   * Split from `current` because they look the same and mean different things to
   * a screen reader. Both light the slot, but "the More sheet is open" is
   * `aria-expanded`, not `aria-current="page"` — the sheet is a menu, not a
   * destination — while "you are on Memory, which More took you to" is exactly
   * `aria-current`. Announcing an open menu as the current page is how a sighted
   * fix becomes an unsighted regression.
   */
  expanded?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      // Present only while selected, and its VALUE says which kind of selected:
      // "page" for a destination you're on, plain "true" for the More slot while
      // its sheet is up — a menu is a current item in this set, not a page.
      aria-current={current ? (expanded ? "true" : "page") : undefined}
      aria-expanded={expanded}
      aria-haspopup={expanded !== undefined ? "dialog" : undefined}
      className={cn(
        // `h-full` + `flex-1` rather than a Button size: the kit's two heights
        // are 24 and 32px and both are under the 44px minimum for a thumb.
        "h-full min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-2xs font-medium",
        // The selected look reads off `aria-current` rather than off a ternary,
        // for the reason the `toggle` variant gives: state you can see and state
        // you can hear then cannot drift apart. It is ALSO the only form that
        // works here. `cn` is plain clsx with no conflict resolution, so the
        // `text-accent-hi` this used to pass sat beside `ghost`'s own
        // `text-secondary` as two same-specificity utilities and lost on emit
        // order — every slot in this bar has rendered #9aa1a9 whatever was
        // selected, which is why nothing appeared to highlight. An attribute
        // variant compiles to `.…[aria-current]` and outranks it.
        "aria-[current]:text-accent-hi",
        // …and outranks `ghost`'s `hover:text-primary` too, which is otherwise
        // the same specificity as the line above and would pull a selected slot
        // back to grey under a mouse.
        "aria-[current]:hover:text-accent-hi",
      )}
    >
      <span className="relative [&_svg]:size-[18px]">
        {icon}
        {count !== undefined && count > 0 && (
          <span className="pointer-events-none absolute -right-2 -top-1">
            <Badge count={count} tone="warn" />
          </span>
        )}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </Button>
  );
}

/** A full-width row in the More sheet. */
function SheetRow({
  icon,
  label,
  count,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="h-11 w-full justify-start gap-2.5 px-3 text-base text-secondary [&_svg]:size-4"
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && count > 0 && <Badge count={count} tone="warn" />}
    </Button>
  );
}

/**
 * True while the caret is in a text field.
 *
 * The shell shrinks to sit above the keyboard (`--cm-kb`, see stores/viewport),
 * so the bar would still be on screen while you type — eating 52px of an
 * already-short window to offer four destinations you aren't going to. It
 * stands down instead: the composer is the whole task at that moment, and the
 * nav is one tap away again on blur.
 *
 * Focus-based rather than composer-specific so it also covers the rename input,
 * the transcript search field and every dialog input — all of which raise the
 * same keyboard.
 */
function useTextEntryFocused(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    // Only on touch. The standdown exists solely to dodge a SOFT keyboard, so
    // on a fine pointer it is all cost and no benefit: focus a field in a
    // narrow desktop window and the nav would vanish with nothing covering it.
    // That also makes the phone layout honest to test by resizing a browser.
    if (!matchMedia("(pointer: coarse)").matches) return;

    const isTextEntry = (el: EventTarget | null): boolean =>
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const onIn = (e: FocusEvent) => setTyping(isTextEntry(e.target));
    const onOut = () => setTyping(false);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return typing;
}

export function BottomNav({ chat }: { chat: Chat | null }) {
  const mode = useLayout((s) => s.mode);
  const pane = useLayout((s) => s.pane);
  const setPane = useLayout((s) => s.setPane);
  const leftOpen = useLayout((s) => s.leftOpen);
  const setLeftOpen = useLayout((s) => s.setLeftOpen);

  const view = useView((s) => s.view);
  const setView = useView((s) => s.setView);
  const counts = usePanelCounts(chat);
  // Focus and the keyboard are not the same event, and the gap between them is
  // where the flicker lived. `focusout` fires the instant you tap away, but the
  // keyboard then takes ~250ms to retract — bringing the bar back on `focusout`
  // alone drops it into the space the keyboard is still occupying, and it jumps
  // again when the retraction finishes. So: hide on focus (immediate, no wait
  // for a keyboard that's still animating in), and only come back once the
  // keyboard has actually gone.
  const focused = useTextEntryFocused();
  const kb = useViewport((s) => s.inset);
  const typing = focused || kb > 0;
  const debug = useViewport((s) => s.debug);
  const toggleDebug = useViewport((s) => s.toggleDebug);
  const [moreOpen, setMoreOpen] = useState(false);

  const project = useProjects((s) => s.activeProjectId);
  const memCount = useProjectMemories(project).length;
  const changeCount = useGitChangeCount();
  // The same "needs you" tally the sidebar rows carry, rolled up onto Chats —
  // the whole point of the badge is to be readable while the sidebar is
  // off-canvas.
  const attention = useAttention(
    (s) => s.items.filter((i) => i.kind === "permission" || i.kind === "question").length,
  );

  /** Where the whole shell is, in the four bits the two rules below read. */
  const place = { mode, view, pane, leftOpen, moreOpen };
  const slot = currentSlot(place);

  /**
   * Both sheets stand down whenever the nav commits to a destination.
   *
   * They are transient chrome layered OVER the main area, not places, so leaving
   * one up across a navigation strands it over a surface it has nothing to do
   * with — pick Memory from the More sheet with the chat picker also open and
   * you land on Memory with a list of chats parked on top of it.
   */
  const dismissSheets = () => {
    setMoreOpen(false);
    dismissLeftDrawer();
  };

  /** Everything below the pane switcher goes back to the transcript first. */
  const goView = (next: AppView) => {
    setView(next);
    // `view` and `pane` are two axes over the same real estate, and
    // `view: "memory"` + `pane: "run"` is representable and meaningless. Resolve
    // it here rather than letting it emerge: choosing a view IS choosing the
    // main area, so the pane resets with it.
    setPane("chat");
    dismissSheets();
  };

  const goPane = (next: Pane) => {
    // Ship/Run are chat-scoped surfaces; leaving Memory or Source Control on
    // screen underneath them would show the panel for a chat you can't see.
    if (view !== "chat") setView("chat");
    setPane(next);
    dismissSheets();
  };

  /**
   * One slot, three meanings — `chatsAction` decides which, this applies it.
   *
   * The picker is only ever REACHED from step two, so it can't be opened over a
   * screen it doesn't belong to: by the time this opens it, the branch has
   * already established you're looking at the transcript.
   */
  const goChats = () => {
    switch (chatsAction(place)) {
      case "open-picker":
        setLeftOpen(true);
        break;
      case "close-picker":
        setLeftOpen(false);
        break;
      case "go-chat":
        if (view !== "chat") setView("chat");
        setPane("chat");
        dismissSheets();
        break;
    }
  };

  const goOverlay = (id: Parameters<typeof openOverlay>[0]) => {
    openOverlay(id);
    dismissSheets();
  };

  // `lg` has no bottom nav at all — every surface it switches between is already
  // on screen at once.
  if (mode === "lg") return null;

  return (
    <>
      {/* In flow as the app column's last row, not `fixed`: a `fixed bottom: 0`
          bar resolves against the LAYOUT viewport while the column above it is
          sized in `dvh`, so the two disagreed by the height of the URL bar and
          left a dead band under the composer. As a sibling row there is no
          second measurement to disagree with.

          While you're typing the row collapses to nothing and only the home
          indicator's inset is left — the standdown described above, now a
          height change rather than a slide, since a bar translated off a box
          that no longer extends under the keyboard would just be gone from the
          layout's point of view anyway. */}
      <nav
        aria-label="Main"
        // With the strip hidden this element is nothing but the home
        // indicator's inset — an empty landmark for a screen reader to announce
        // and offer to jump to.
        aria-hidden={typing || undefined}
        style={{ zIndex: LAYER.bottomNav }}
        className={cn(
          "relative flex shrink-0 cm-safe-x bg-surface",
          // The home indicator's inset only means anything when the home
          // indicator is what's down there. With the keyboard up it's the
          // keyboard, and iOS does not reliably zero the inset for you — so
          // keeping the padding leaves a 34px band of nothing between the
          // composer and the keys.
          //
          // With no keyboard it's a THREE-way choice, not two, because the
          // reduced clearance is only PAID FOR by the slots that grow into the
          // rest of the inset (see index.css). In the standdown gap — focused,
          // keyboard still animating in, `kb` not yet non-zero — the strip is
          // `hidden`, so nothing has grown into anything and the full inset is
          // again the honest reservation. Shrinking it there would edge the
          // composer into the gesture area for the ~250ms before the keyboard
          // lands. The condition is deliberately the SAME `typing` the strip
          // reads, so "strip hidden" and "full inset" cannot come apart.
          kb > 0 ? "pb-0" : typing ? "cm-safe-b" : "pb-[var(--cm-bottom-nav-clear)]",
          !typing && "border-t border-line",
        )}
      >
        {/* The slots' band is `--cm-bottom-nav-strip`: the 52px they need PLUS
            the part of the home indicator's inset they're allowed to grow into.
            The bar's total height is unchanged (`strip + clear` is still
            `52px + inset`), so nothing above it moves — the icons just stop
            floating in the top half of it. Overlays that cover the bar reserve
            `--cm-bottom-nav-space`, which is derived from both. */}
        {/* `hidden`, not a zero height or a transform: a strip you can't see but
            can still tab into and hear announced is worse than one that's gone.
            Blur brings it straight back. */}
        <div
          className={cn(
            "w-full items-stretch",
            typing ? "hidden" : "flex h-[var(--cm-bottom-nav-strip)]",
          )}
        >
          {/* The transcript AND the list of transcripts, in that order. Always
              rendered, at every mode and on every view — the ☰ it absorbed was
              conditional on both, and a slot that comes and goes is a slot you
              can't reach for without looking. */}
          <NavSlot
            icon={<MessageSquare />}
            label="Chats"
            // Only where the rail is off-canvas. At `md` the sidebar is an
            // inline column carrying these same counts on the rows themselves,
            // so a roll-up beside it is the number twice.
            count={mode === "sm" ? attention : undefined}
            current={slot === "chats"}
            onClick={goChats}
          />
          {/* Both panels are chat-scoped and only render inside the chat branch
              of `App`, so with no chat open these slots would light up over an
              empty main area. Dimmed rather than hidden: a nav bar whose slots
              come and go is a nav bar you can't build muscle memory for. */}
          <NavSlot
            icon={<Ship />}
            label="Ship"
            count={counts.ship}
            current={slot === "ship"}
            disabled={!chat}
            onClick={() => goPane("ship")}
          />
          <NavSlot
            icon={<Play />}
            label="Run"
            count={counts.run}
            current={slot === "run"}
            disabled={!chat}
            onClick={() => goPane("run")}
          />
          {/* A toggle, not an opener. The sheet's only other dismissals are
              picking a row (which navigates you away, so it can't be how you
              back OUT) and the scrim above it — which on a tall sheet is a
              sliver of screen you have to aim at. Pressing the control you
              opened it with is the gesture everyone tries first. */}
          <NavSlot
            icon={<MoreHorizontal />}
            label="More"
            current={slot === "more"}
            expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          />
        </div>
      </nav>

      {/* Everything the top bar drops below `md`, plus the sidebar's two
          top-level nav buttons — which are unreachable behind a closed drawer. */}
      <Drawer
        open={moreOpen}
        // Unconditional: this component has already returned null at `lg`.
        enabled
        onClose={() => setMoreOpen(false)}
        side="bottom"
        label="More"
        className="max-h-[76dvh] flex-col overflow-hidden rounded-t-lg border-t border-line-strong bg-overlay/98 backdrop-blur-md"
      >
        {/* `min-h-0`: a flex child's default `min-height: auto` is its content,
            so without this the list refuses to shrink under the sheet's
            `max-h` and scrolls the page instead of itself. */}
        <div className="cm-scroll min-h-0 overflow-y-auto p-1.5 pb-[calc(var(--cm-bottom-nav-space)+0.375rem)]">
          <SheetRow
            icon={<Brain />}
            label="Memory"
            count={memCount}
            onClick={() => goView(view === "memory" ? "chat" : "memory")}
          />
          <SheetRow
            icon={<GitBranch />}
            label="Source Control"
            count={changeCount}
            onClick={() => goView(view === "git" ? "chat" : "git")}
          />
          <SheetRow
            icon={<FolderOpen />}
            label="Files"
            onClick={() => goView(view === "files" ? "chat" : "files")}
          />
          <SheetRow
            icon={<BarChart3 />}
            label="Metrics"
            onClick={() => goView(view === "metrics" ? "chat" : "metrics")}
          />
          <div className="my-1 h-px bg-line-soft" />
          <SheetRow
            icon={<GitPullRequest />}
            label="Pull requests"
            onClick={() => {
              // PRs are a Workspace tab now, not their own overlay — so this
              // opens the same list every other entry point does.
              openWorkspace("prs");
              setMoreOpen(false);
            }}
          />
          <SheetRow icon={<Blocks />} label="MCP tools" onClick={() => goOverlay("mcp")} />
          {/* Both settings surfaces are pages now, so they go through `goView`
              with the rest of the destinations rather than `goOverlay` — which
              is also what makes them toggle back to the transcript on a second
              tap, the way Memory and Source Control already did. */}
          <SheetRow
            icon={<FileCog />}
            label="Project config"
            onClick={() => goView(view === "project-settings" ? "chat" : "project-settings")}
          />
          <SheetRow
            icon={<Settings />}
            label="Settings"
            onClick={() => goView(view === "app-settings" ? "chat" : "app-settings")}
          />
          <div className="my-1 h-px bg-line-soft" />
          {/* An iPhone can't be inspected remotely from Windows, and the shell
              bugs this diagnoses only happen in the installed PWA — no console,
              no inspector, no URL bar to add a flag to. This row is the only way
              in. Off by default and never persisted. */}
          <SheetRow
            icon={<Ruler />}
            label={debug ? "Hide viewport readout" : "Viewport readout"}
            onClick={toggleDebug}
          />
          <div className="my-1 h-px bg-line-soft" />
          {/* The attention queue is a triage LIST, not a destination, so it keeps
              its popover rather than becoming a row that opens another sheet. */}
          <div className="px-3 py-2">
            <AttentionPopover />
          </div>
        </div>
      </Drawer>
    </>
  );
}
