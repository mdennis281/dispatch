import { useEffect, useState, type ReactNode } from "react";
import {
  Menu,
  MessageSquare,
  Ship,
  Play,
  MoreHorizontal,
  Brain,
  GitBranch,
  Settings,
  Blocks,
  FileCog,
  GitPullRequest,
} from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { Drawer } from "./Drawer.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Chip.js";
import { AttentionPopover } from "../attention/AttentionPopover.js";
import { usePanelCounts } from "../panels/usePanelCounts.js";
import { useLayout, type Pane } from "../../stores/layout.js";
import { useView, openOverlay, type AppView } from "../../stores/view.js";
import { useAttention } from "../../stores/attention.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useProjects } from "../../stores/projects.js";
import { useGitChangeCount } from "../../stores/git.js";
import { LAYER } from "../../lib/layers.js";
import { cn } from "../../lib/cn.js";

/**
 * ONE bar, not two.
 *
 * The obvious mobile layout is a pane switcher plus a separate drawer handle,
 * and it's wrong: two bars competing to answer "where am I" answer it twice and
 * agree never. So the ☰ slot lives in the same strip as the panes even though it
 * isn't one — it opens modal chrome LAYERED OVER whichever pane is active, and
 * it never lights up as selected. The three pane slots are the only ones that
 * can be current.
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
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** Selected — only ever true for a PANE slot. ☰ and ⋯ open things, they aren't places. */
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-current={current ? "page" : undefined}
      className={cn(
        // `h-full` + `flex-1` rather than a Button size: the kit's two heights
        // are 24 and 32px and both are under the 44px minimum for a thumb.
        "h-full min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-2xs font-medium",
        current ? "text-accent-hi" : "text-muted",
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
 * A `fixed bottom-0` bar and a soft keyboard are a fight the bar always loses:
 * iOS shrinks the VISUAL viewport but not the layout viewport, so `bottom: 0`
 * stays pinned to the bottom of the page and the bar ends up behind the
 * keyboard — or, in the standalone PWA, floating halfway up the screen over the
 * transcript. Rather than track `visualViewport` (a resize storm on every
 * keyboard animation frame, and a second source of truth about the shell's
 * height), the bar simply stands down while you're typing: the composer is the
 * whole task at that moment, and the nav is one tap away again on blur.
 *
 * Focus-based rather than composer-specific so it also covers the rename input,
 * the transcript search field and every dialog input — all of which raise the
 * same keyboard.
 */
function useTextEntryFocused(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
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
  const typing = useTextEntryFocused();
  const [moreOpen, setMoreOpen] = useState(false);

  const project = useProjects((s) => s.activeProjectId);
  const memCount = useProjectMemories(project).length;
  const changeCount = useGitChangeCount();
  // The same "needs you" tally the sidebar rows carry, rolled up onto ☰ — the
  // whole point of the badge is to be readable while the sidebar is off-canvas.
  const attention = useAttention(
    (s) => s.items.filter((i) => i.kind === "permission" || i.kind === "question").length,
  );

  // Project setup takes the whole window and isn't scoped to a project, so the
  // sidebar is hidden there (App's `fullBleed`). A ☰ that opens an empty drawer
  // over it would be a control that does nothing.
  const canOpenLeft = view !== "new-project";

  /** Everything below the pane switcher goes back to the transcript first. */
  const goView = (next: AppView) => {
    setView(next);
    // `view` and `pane` are two axes over the same real estate, and
    // `view: "memory"` + `pane: "run"` is representable and meaningless. Resolve
    // it here rather than letting it emerge: choosing a view IS choosing the
    // main area, so the pane resets with it.
    setPane("chat");
    setMoreOpen(false);
  };

  const goPane = (next: Pane) => {
    // Ship/Run are chat-scoped surfaces; leaving Memory or Source Control on
    // screen underneath them would show the panel for a chat you can't see.
    if (view !== "chat") setView("chat");
    setPane(next);
  };

  const goOverlay = (id: Parameters<typeof openOverlay>[0]) => {
    openOverlay(id);
    setMoreOpen(false);
  };

  // `lg` has no bottom nav at all — every surface it switches between is already
  // on screen at once.
  if (mode === "lg") return null;

  return (
    <>
      <nav
        aria-label="Main"
        style={{ zIndex: LAYER.bottomNav }}
        className={cn(
          "fixed inset-x-0 bottom-0 flex cm-safe-b cm-safe-x border-t border-line bg-surface",
          "transition-transform duration-150 ease-[var(--ease-out)] motion-reduce:transition-none",
          typing && "pointer-events-none translate-y-full",
        )}
      >
        {/* The bar's own height is a variable so panes can reserve exactly it —
            see `--cm-bottom-nav-space` in index.css. */}
        <div className="flex h-[var(--cm-bottom-nav-h)] w-full items-stretch">
          {mode === "sm" && canOpenLeft && (
            <NavSlot
              icon={<Menu />}
              label="Chats"
              count={attention}
              onClick={() => setLeftOpen(!leftOpen)}
            />
          )}
          <NavSlot
            icon={<MessageSquare />}
            label="Chat"
            current={pane === "chat"}
            onClick={() => goPane("chat")}
          />
          {/* Both panels are chat-scoped and only render inside the chat branch
              of `App`, so with no chat open these slots would light up over an
              empty main area. Dimmed rather than hidden: a nav bar whose slots
              come and go is a nav bar you can't build muscle memory for. */}
          <NavSlot
            icon={<Ship />}
            label="Ship"
            count={counts.ship}
            current={pane === "ship"}
            disabled={!chat}
            onClick={() => goPane("ship")}
          />
          <NavSlot
            icon={<Play />}
            label="Run"
            count={counts.run}
            current={pane === "run"}
            disabled={!chat}
            onClick={() => goPane("run")}
          />
          <NavSlot icon={<MoreHorizontal />} label="More" onClick={() => setMoreOpen(true)} />
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
        className="max-h-[76dvh] flex-col rounded-t-lg border-t border-line-strong bg-overlay/98 backdrop-blur-md"
      >
        <div className="cm-scroll overflow-y-auto p-1.5 pb-[calc(var(--cm-bottom-nav-space)+0.375rem)]">
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
          <div className="my-1 h-px bg-line-soft" />
          <SheetRow
            icon={<GitPullRequest />}
            label="Pull requests"
            onClick={() => goOverlay("prs")}
          />
          <SheetRow icon={<Blocks />} label="MCP tools" onClick={() => goOverlay("mcp")} />
          <SheetRow icon={<FileCog />} label="Project config" onClick={() => goOverlay("config")} />
          <SheetRow icon={<Settings />} label="Settings" onClick={() => goOverlay("settings")} />
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
