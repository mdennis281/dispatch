/**
 * The current path — as breadcrumbs you can click, or as a text field you can
 * paste into.
 *
 * Crumbs only ever walk UP. Getting to a path you already know (one copied out
 * of a terminal, or out of an error message) means clicking down through six
 * folders, and every file manager solves that the same way: click the empty
 * space beside the trail, or press ⌘/Ctrl-L, and the trail becomes an input.
 * It is also the only way to reach a location with no crumb to click — a UNC
 * share, or a drive that isn't in the Places list.
 *
 * Shared by the full page and the picker modal. It started as a local component
 * in `FilesView`, and the modal showed the same path as dead text; two
 * implementations of "where am I" is how one of them ends up navigable and the
 * other doesn't.
 *
 * EDITING IS CONTROLLED by the caller, deliberately. The obvious version owns
 * its own `editing` flag and binds ⌘/Ctrl-L to a window listener — which is
 * fine until both surfaces are mounted at once (the picker opens over the Files
 * page), at which point two listeners fire on one keystroke and two path bars
 * open, one of them behind a modal. Each surface knows how it wants to be
 * triggered — the page globally, the dialog only while focus is inside it — so
 * each one owns that decision and passes the result in.
 */
import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import type { FsCrumb } from "@dispatch/shared";
import { TextInput } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/cn.js";

export interface PathBarProps {
  /** Root-to-here trail, from `fsCrumbs`. */
  crumbs: FsCrumb[];
  /** The current directory, and the text the field opens with. */
  cwd: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onNavigate: (path: string) => void;
  className?: string;
}

export function PathBar({
  crumbs,
  cwd,
  editing,
  onEditingChange,
  onNavigate,
  className,
}: PathBarProps) {
  const trailRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the CURRENT directory in view.
   *
   * The trail scrolls horizontally, and it grows to the right — so on anything
   * narrower than a full page a deep path renders scrolled to the root, showing
   * `C:/ › Users › …` and hiding the one crumb that says where you actually
   * are. Pinning it to the end is the same reason a terminal scrolls to the
   * bottom rather than the top.
   */
  useEffect(() => {
    const el = trailRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs, editing]);

  if (editing) {
    return (
      <div className={cn("px-3 py-1.5 cm-hairline-b", className)}>
        <TextInput
          mono
          autoFocus
          defaultValue={cwd}
          // Uncontrolled: the field's value is a DRAFT that only means anything
          // when Enter commits it, and holding it in state here would re-render
          // the whole browser on every keystroke of a path nobody has navigated
          // to yet.
          onBlur={() => onEditingChange(false)}
          onKeyDown={(e) => {
            // A text field consumes its own keystrokes. Both surfaces bind
            // Enter / Backspace / arrows to list navigation, so without this,
            // typing a path moves the selection and Backspace jumps a directory
            // up instead of deleting a character.
            e.stopPropagation();
            if (e.key === "Enter") {
              onNavigate(e.currentTarget.value);
              onEditingChange(false);
            } else if (e.key === "Escape") {
              onEditingChange(false);
            }
          }}
          placeholder="Type or paste a path, then Enter"
          aria-label="Current path"
        />
      </div>
    );
  }

  return (
    <div
      ref={trailRef}
      className={cn(
        "cm-scroll flex items-center gap-0.5 overflow-x-auto px-3 py-1.5 cm-hairline-b",
        className,
      )}
    >
      {crumbs.map((crumb, i) => (
        <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="size-3 text-faint" />}
          <Button
            variant="ghost"
            onClick={() => onNavigate(crumb.path)}
            className={cn("!px-1.5", i === crumbs.length - 1 && "font-medium text-primary")}
          >
            {crumb.label}
          </Button>
        </span>
      ))}
      {/* The dead space after the last crumb is the click target every file
          manager uses to get an editable path. `min-w` so it stays hittable
          even when the trail has already filled the row. */}
      <div
        className="h-6 min-w-[3rem] flex-1 cursor-text"
        onClick={() => onEditingChange(true)}
        title="Edit path (Ctrl+L)"
      />
    </div>
  );
}

/** True when this keystroke is the "edit the path" shortcut. */
export function isEditPathShortcut(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L");
}
