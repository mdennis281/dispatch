/**
 * Window-wide awareness of an in-flight file drag.
 *
 * Two jobs, and the second is why this is window-level rather than a handler on
 * the composer:
 *
 *  1. Tell the UI a drag is happening ANYWHERE over the app, so the drop target
 *     can announce itself before the pointer ever reaches it. A drop affordance
 *     that only appears once you're already on the target teaches nothing — the
 *     user has to guess the feature exists to discover it.
 *
 *  2. Cancel every drop the app doesn't handle. A file dropped on an inert part
 *     of the page makes the browser navigate to it — and in an installed PWA
 *     window that replaces the running app with a file viewer, with no address
 *     bar and no back button to undo it. So the window swallows the default for
 *     any file drag, and only the real drop targets opt back in.
 *
 * Liveness comes from `dragover`, which repeats every few hundred ms for as long
 * as a drag is over the window, rather than from balancing `dragenter` against
 * `dragleave`. The counting version loses track when a drag leaves across a
 * window edge, ends on Escape, or crosses an iframe — each of which strands the
 * overlay on screen with no way to dismiss it.
 */
import { useEffect, useState } from "react";
import { dropIntent, type DropIntent } from "./dropPaths.js";

/** No `dragover` for this long ⇒ the drag is gone (they repeat far faster). */
const DRAG_IDLE_MS = 220;

export interface FileDrag {
  /** A file-ish drag is currently over the window. */
  active: boolean;
  /** What a drop would do, as far as a `dragover` can tell. */
  intent: DropIntent;
}

const IDLE: FileDrag = { active: false, intent: null };

export function useFileDrag(): FileDrag {
  const [drag, setDrag] = useState<FileDrag>(IDLE);

  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    // Compared before every setState: a drag fires `dragover` continuously, and
    // re-rendering the tree ~10×/second for an unchanged banner would make the
    // whole window stutter under the pointer.
    let current: FileDrag = IDLE;

    const clear = () => {
      clearTimeout(idle);
      if (current.active) {
        current = IDLE;
        setDrag(IDLE);
      }
    };

    const onDragOver = (e: DragEvent) => {
      const intent = dropIntent(e.dataTransfer);
      if (!intent) return;

      // Job 2: claim the drop so the browser can't navigate to the file. The
      // real targets call preventDefault themselves; this is the fallback for
      // every square pixel that doesn't.
      e.preventDefault();

      clearTimeout(idle);
      idle = setTimeout(clear, DRAG_IDLE_MS);
      if (!current.active || current.intent !== intent) {
        current = { active: true, intent };
        setDrag(current);
      }
    };

    // A drop the app didn't consume: `defaultPrevented` means a real target
    // already took it. Otherwise swallow it — dropping a file on the transcript
    // should do nothing, not navigate away from a running session.
    const onDrop = (e: DragEvent) => {
      if (!e.defaultPrevented && dropIntent(e.dataTransfer)) e.preventDefault();
      clear();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", clear);
    // Escape-to-cancel leaves no drag event of its own on some platforms.
    window.addEventListener("blur", clear);

    return () => {
      clearTimeout(idle);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return drag;
}
