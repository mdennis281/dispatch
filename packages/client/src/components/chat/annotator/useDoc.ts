/**
 * Document state and undo history.
 *
 * The protocol is two calls: `mark()` once before a change, then any number of
 * `edit()` calls. Everything between one `mark` and the next collapses into a
 * single undo step, which is what makes a freehand stroke undo as one stroke
 * rather than as four hundred pointermove events — and makes a crop undo as a
 * crop, restoring both the bitmap and the annotation coordinates it moved.
 *
 * A snapshot holds a reference to the base bitmap, not a copy. Only a crop ever
 * creates a new bitmap, so the history costs one canvas per crop and an array of
 * shape references per step.
 */
import { useCallback, useMemo, useState } from "react";
import type { Shape } from "./doc.js";
import type { Bitmap } from "./render.js";

export interface DocState {
  base: Bitmap;
  shapes: Shape[];
}

/** Deep enough undo for a long markup session, shallow enough to stay bounded. */
const LIMIT = 40;

interface History {
  past: DocState[];
  present: DocState;
  future: DocState[];
}

export interface DocApi {
  base: Bitmap;
  shapes: Shape[];
  canUndo: boolean;
  canRedo: boolean;
  /** Open a new undo step. Call once, before the first `edit` of a change. */
  mark: () => void;
  /** Change the document without opening a step. */
  edit: (next: Partial<DocState> | ((s: DocState) => Partial<DocState>)) => void;
  undo: () => void;
  redo: () => void;
  /**
   * Abandon the step opened by the last `mark()`, leaving no history behind.
   * A click that starts a rectangle and never drags is not an edit, and it
   * should not cost the user an Undo press to discover that.
   */
  discard: () => void;
  /** True once anything has been drawn or cropped — drives the Apply button. */
  dirty: boolean;
}

export function useDoc(initial: Bitmap): DocApi {
  const [h, setH] = useState<History>({
    past: [],
    present: { base: initial, shapes: [] },
    future: [],
  });

  const mark = useCallback(() => {
    setH((s) => ({
      past: [...s.past, s.present].slice(-LIMIT),
      present: s.present,
      // Any new edit abandons the redo branch — the standard linear-history rule.
      future: [],
    }));
  }, []);

  const edit = useCallback<DocApi["edit"]>((next) => {
    setH((s) => {
      const patch = typeof next === "function" ? next(s.present) : next;
      return { ...s, present: { ...s.present, ...patch } };
    });
  }, []);

  const undo = useCallback(() => {
    setH((s) => {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return { past: s.past.slice(0, -1), present: prev, future: [s.present, ...s.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setH((s) => {
      const [next, ...rest] = s.future;
      if (!next) return s;
      return { past: [...s.past, s.present], present: next, future: rest };
    });
  }, []);

  const discard = useCallback(() => {
    setH((s) => {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return { past: s.past.slice(0, -1), present: prev, future: s.future };
    });
  }, []);

  return useMemo(
    () => ({
      base: h.present.base,
      shapes: h.present.shapes,
      canUndo: h.past.length > 0,
      canRedo: h.future.length > 0,
      dirty: h.past.length > 0 || h.present.shapes.length > 0,
      mark,
      edit,
      undo,
      redo,
      discard,
    }),
    [h, mark, edit, undo, redo, discard],
  );
}
