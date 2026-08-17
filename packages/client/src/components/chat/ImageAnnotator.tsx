/**
 * Image markup editor — a full markup surface for a composer attachment, opened
 * by clicking an attachment thumbnail before sending.
 *
 * Built on Konva (canvas engine + hit testing + touch normalisation) with the
 * entire editor UI owned here, rather than on a drop-in editor that ships its
 * own chrome. That is a deliberate reversal: the previous version wrapped
 * marker.js 2 and CROPRO, and every complaint about it — colours and stroke
 * width reset on every reopen, no zoom, controls landing on top of the picture,
 * cropping destroying your annotations — was downstream of those libraries
 * owning the state and the layout. Konva owns pixels; we own everything a person
 * touches.
 *
 * The design in one line: the DOCUMENT (base bitmap + shapes) is in natural
 * image pixels, the VIEWPORT (zoom/pan) is a pure view transform, and a crop is
 * a coordinate change applied to both. See doc.ts for why that is what keeps
 * annotations editable after a crop.
 *
 * On Apply the result is flattened to a PNG at natural size and re-uploaded
 * through the existing asset flow (POST /api/chats/:id/assets → ImageRef),
 * returned to the Composer which swaps it in place of the original attachment.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Group, Image as KonvaImage, Layer, Stage } from "react-konva";
import type Konva from "konva";
import {
  Check,
  Crop as CropIcon,
  FlipHorizontal2,
  FlipVertical2,
  ImageOff,
  Maximize2,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ImageRef } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";
import { useViewport } from "../../stores/viewport.js";
import { uploadChatImage } from "../../lib/actions.js";
import { useAnnotatorPrefs } from "../../lib/annotatorPrefs.js";
import {
  type BakeOp,
  type Rect,
  type Shape,
  type ShapeKind,
  bakeShapes,
  clampRect,
  insetCrop,
  isBox,
  newId,
  normalize,
  rotatedBounds,
} from "./annotator/doc.js";
import { type Bitmap, bakeImage, bitmapSize, exportStage, loadImage } from "./annotator/render.js";
import { CropOverlay } from "./annotator/CropOverlay.js";
import { SelectionOverlay } from "./annotator/SelectionOverlay.js";
import { ShapeNode } from "./annotator/ShapeNode.js";
import { type ToolId, Toolbar } from "./annotator/Toolbar.js";
import { useDoc } from "./annotator/useDoc.js";
import * as vpm from "./annotator/viewport.js";

export interface ImageAnnotatorProps {
  chatId: string;
  /** Resolved URL of the attachment to edit (same-origin asset endpoint). */
  src: string;
  /** Carried onto the replacement ImageRef so the label survives an edit. */
  alt?: string;
  onCancel: () => void;
  onApply: (ref: ImageRef) => void;
}

/**
 * Is this dialog full-bleed right now?
 *
 * Deliberately NOT `useLayoutMode() === "sm"`. The shell's `sm` ends at 768px
 * and Tailwind's ends at 640px, and in the 128px between them this panel is
 * already a centred card whose root has cleared the insets with its own gutter
 * — paying them inline as well would push the editor down by a second status
 * bar. The boundary that matters here is the one the `sm:` classes on this very
 * element use, so read exactly that.
 */
const FULL_BLEED = "(max-width: 39.98rem)";

function useFullBleed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(FULL_BLEED);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(FULL_BLEED).matches,
    // The client's vitest runner has no DOM; the desktop answer is the one a
    // headless render should produce, matching `currentMode`'s fallback.
    () => false,
  );
}

/**
 * Why the editor's header is where it is — on the device, in the editor.
 *
 * The overlap has now survived one shipped fix, and every number that could
 * have caught it is only readable in a Web Inspector this phone cannot be
 * attached to. Layout alone can't tell the two candidate causes apart: padding
 * that never applied, and padding that applied to a box whose origin isn't the
 * top of the glass. So read both at once, off the real elements:
 *
 *  - `pad-t`  what the panel's padding-top COMPUTED to. 0 means the inset never
 *             reached the box, whatever the stylesheet says.
 *  - `var-t`  what `--cm-safe-top` resolves to on that same box — the CSS path
 *             the shipped fix used.
 *  - `js-t`   the same inset as measured by the probe, which is what the inline
 *             style now pays. `var-t` ≠ `js-t` indicts `env()` in a variable.
 *  - `hdr-t`  where the header's top edge actually IS. If this equals `pad-t`
 *             and the buttons are still in the clock, the box starts above the
 *             glass and no amount of padding will ever move them.
 *
 * Rides the same switch as the rest of the viewport debug (More → toggle), so
 * it is off for everyone by default and never persisted.
 */
function AnnotatorGeometryDebug({ panelRef }: { panelRef: React.RefObject<HTMLDivElement | null> }) {
  const debug = useViewport((s) => s.debug);
  const jsTop = useViewport((s) => s.safeTop);
  const [read, setRead] = useState<{ pad: string; varTop: string; hdr: number; panel: number } | null>(
    null,
  );

  useEffect(() => {
    if (!debug) return;
    // After paint, and again on the next frame: the panel mounts before the
    // Konva stage sizes itself, and a first-frame read would report the box it
    // had rather than the one it settles at.
    const read1 = () => {
      const el = panelRef.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      const header = el.querySelector("header");
      setRead({
        pad: cs.paddingTop,
        varTop: cs.getPropertyValue("--cm-safe-top").trim() || "(unset)",
        hdr: Math.round(header?.getBoundingClientRect().top ?? -1),
        panel: Math.round(el.getBoundingClientRect().top),
      });
    };
    // Both ids, or closing the dialog inside two frames leaves the inner frame
    // armed to `setRead` on an unmounted component.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(read1);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [debug, panelRef]);

  if (!debug || !read) return null;
  const rows: Array<[string, string]> = [
    ["pad-t", read.pad],
    ["var-t", read.varTop],
    ["js-t", `${jsTop}`],
    ["panel-t", `${read.panel}`],
    ["hdr-t", `${read.hdr}`],
  ];
  return (
    <div className="pointer-events-none absolute right-1 top-1 z-50 rounded border border-line-strong bg-black/80 px-1.5 py-1 font-mono text-2xs leading-tight text-white">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-1.5">
          <span className="w-11 shrink-0 text-white/45">{k}</span>
          <span className="text-cyan-300">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Screen-pixel radius for grabbing a crop corner. Sized for a fingertip. */
const CROP_GRAB = 28;
/**
 * Minimum SCREEN-space movement, in CSS pixels, before a stroke records another
 * point. Screen-space rather than image-space on purpose: it makes the sampling
 * rate follow the zoom, so detail work at 8× records eight times more points per
 * image pixel and the stroke stays as smooth as it looked while being drawn.
 */
const DECIMATE = 1.5;
/** Below this a drag is a click, and a click should not leave a 2px rectangle. */
const MIN_DRAG = 4;

type Mode = "markup" | "crop";

type Drag =
  | { kind: "none" }
  | { kind: "pan"; last: { x: number; y: number } }
  | { kind: "pinch"; startDist: number; startScale: number }
  | { kind: "draw"; id: string; moved: boolean }
  // `marked` defers opening the undo step until the shape actually moves —
  // a click that only selects is not an edit.
  | { kind: "move"; id: string; last: [number, number]; marked: boolean }
  | { kind: "handle"; id: string; handle: string; marked: boolean }
  | { kind: "crop-new"; origin: [number, number] }
  | { kind: "crop-move"; last: [number, number] }
  | { kind: "crop-handle"; corner: string };

export default function ImageAnnotator(props: ImageAnnotatorProps) {
  const z = useDialogLayer();
  const [base, setBase] = useState<Bitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Full-bleed means this panel, not its root, owns the insets.
  const phone = useFullBleed();
  const safeTop = useViewport((s) => s.safeTop);
  const safeBottom = useViewport((s) => s.safeBottom);

  useEffect(() => {
    let live = true;
    loadImage(props.src).then(
      (img) => live && setBase(img),
      () => live && setError("Could not load this image."),
    );
    return () => {
      live = false;
    };
  }, [props.src]);

  return createPortal(
    <div
      style={{ zIndex: z }}
      className="fixed inset-0 flex items-center justify-center sm:cm-safe-pad sm:[--cm-gutter:1.5rem]"
    >
      <div className="fixed inset-0 bg-scrim backdrop-blur-[2px]" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit image"
        // MEASURED insets, applied inline, rather than the `cm-safe-pad` class
        // this used to carry. The class demonstrably reaches the stylesheet and
        // `--cm-safe-top` demonstrably resolves (the debug readout is positioned
        // by it), yet the header stayed under the clock on a real installed PWA
        // — so the CSS path has one unknown too many to keep betting on. These
        // are the same numbers the probe in `stores/viewport` reads out of the
        // engine, and an inline style cannot be out-ordered, out-layered or
        // out-specified by anything.
        style={phone ? { paddingTop: safeTop, paddingBottom: safeBottom } : undefined}
        className={cn(
          // Full-bleed on a phone. A centred card with margins wastes the only
          // dimension a phone is short on, and the canvas is the whole point.
          "relative z-10 flex h-full w-full flex-col overflow-hidden bg-overlay",
          "sm:h-auto sm:max-h-full sm:max-w-[1180px] sm:rounded-lg sm:border sm:border-line-strong",
          "sm:shadow-[var(--shadow-pop)] sm:backdrop-blur-md sm:cm-anim-rise",
        )}
      >
        <AnnotatorGeometryDebug panelRef={panelRef} />
        {base ? (
          <Editor {...props} base={base} />
        ) : (
          <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-muted sm:h-[420px]">
            {error ? (
              <>
                <ImageOff className="size-6 text-danger" />
                <p className="text-sm text-danger">{error}</p>
                <Button variant="subtle" size="sm" onClick={props.onCancel}>
                  Close
                </Button>
              </>
            ) : (
              <Spinner size={20} />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Editor({ chatId, alt, base: initialBase, onCancel, onApply }: ImageAnnotatorProps & { base: Bitmap }) {
  const doc = useDoc(initialBase);
  const image = useMemo(() => bitmapSize(doc.base), [doc.base]);

  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [vp, setVp] = useState<vpm.Viewport>({ scale: 1, x: 0, y: 0 });

  const [tool, setTool] = useState<ToolId>("pen");
  const [mode, setMode] = useState<Mode>("markup");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);

  // Crop-mode state. `angle` folds quarter turns and straighten into one number,
  // which is exactly what BakeOp wants (see doc.ts).
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [turns, setTurns] = useState(0);
  const [straighten, setStraighten] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const angle = turns * 90 + straighten;

  const drag = useRef<Drag>({ kind: "none" });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const textRef = useRef<HTMLTextAreaElement>(null);
  const styles = useAnnotatorPrefs((s) => s.styles);
  const setStyle = useAnnotatorPrefs((s) => s.setStyle);

  const selected = doc.shapes.find((s) => s.id === selectedId) ?? null;
  /** The style row edits the selection when there is one, else the active tool. */
  const styleKind: ShapeKind = selected?.kind ?? (tool === "select" ? "pen" : tool);
  const activeStyle = styles[styleKind];

  const accent = useMemo(
    () =>
      typeof getComputedStyle === "function"
        ? getComputedStyle(document.documentElement).getPropertyValue("--p-accent").trim() || "#4c8dff"
        : "#4c8dff",
    [],
  );

  /* ---- viewport ---------------------------------------------------------- */

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * The coordinate frame currently on screen. In crop mode that is the ROTATED
   * bounding box, not the image: the crop rect is expressed in the rotated frame
   * (BakeOp.crop), so the preview has to be rotated into the same frame or the
   * frame and the picture drift apart the moment you press Rotate.
   */
  const frame = useMemo(
    () =>
      mode === "crop"
        ? (() => {
            const b = rotatedBounds(image.width, image.height, angle);
            return { width: b.w, height: b.h };
          })()
        : image,
    [angle, image, mode],
  );

  // Refit exactly once per frame — on open, after a crop, on entering crop mode
  // and after every rotate. NOT on every box change: a phone's URL bar
  // collapsing mid-annotation would otherwise yank the view back to Fit.
  const fittedFor = useRef("");
  useLayoutEffect(() => {
    if (!box.width || !box.height) return;
    const key = `${mode}:${frame.width}x${frame.height}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    setVp(vpm.fit(frame, box));
  }, [box, frame, mode]);

  const zoomBy = useCallback(
    (factor: number) => {
      setVp((v) => vpm.zoomAt(v, v.scale * factor, box.width / 2, box.height / 2, frame, box));
    },
    [box, frame],
  );

  const doFit = useCallback(() => setVp(vpm.fit(frame, box)), [frame, box]);

  /**
   * Wheel is bound natively rather than through React's `onWheel`, because React
   * registers its root wheel listener as PASSIVE — `preventDefault` from a React
   * handler is ignored with a console warning, and the page scrolls behind the
   * dialog on every zoom.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setVp((v) =>
        vpm.zoomAt(
          v,
          v.scale * vpm.wheelFactor(e.deltaY, e.deltaMode),
          e.clientX - r.left,
          e.clientY - r.top,
          frame,
          box,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [box, frame]);

  /* ---- geometry helpers -------------------------------------------------- */

  const pointOf = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const r = boxRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }, []);

  const imageOf = useCallback(
    (p: { x: number; y: number }): [number, number] => vpm.toImage(vp, p.x, p.y),
    [vp],
  );

  /** Which crop corner, if any, is under a screen point. */
  const cropCornerAt = useCallback(
    (p: { x: number; y: number }): string | null => {
      const corners: [string, number, number][] = [
        ["nw", crop.x, crop.y],
        ["ne", crop.x + crop.w, crop.y],
        ["se", crop.x + crop.w, crop.y + crop.h],
        ["sw", crop.x, crop.y + crop.h],
      ];
      for (const [name, ix, iy] of corners) {
        const [sx, sy] = vpm.toScreen(vp, ix, iy);
        if (Math.hypot(sx - p.x, sy - p.y) <= CROP_GRAB) return name;
      }
      return null;
    },
    [crop, vp],
  );

  /* ---- shape creation ---------------------------------------------------- */

  const createShape = useCallback(
    (kind: ShapeKind, x: number, y: number): Shape => {
      const { color, width } = styles[kind];
      const id = newId();
      switch (kind) {
        case "pen":
        case "highlight":
          return { id, kind, points: [x, y, x, y], color, width };
        case "arrow":
          return { id, kind, x1: x, y1: y, x2: x, y2: y, color, width };
        case "text":
          return { id, kind, x, y, text: "", color, fontSize: width };
        default:
          return { id, kind, x, y, w: 0, h: 0, color, width };
      }
    },
    [styles],
  );

  const patch = useCallback(
    (id: string, fn: (s: Shape) => Shape) => {
      doc.edit((d) => ({ shapes: d.shapes.map((s) => (s.id === id ? fn(s) : s)) }));
    },
    [doc],
  );

  /**
   * Focus the text field a frame after it mounts, rather than with `autoFocus`.
   * The field is created from a pointerdown handler, and the browser's own
   * default action for that same press — focusing the element under the pointer,
   * i.e. the canvas — runs afterwards and takes the focus straight back. A frame
   * later there is nothing left to race with.
   */
  useEffect(() => {
    if (!editingText) return;
    const id = requestAnimationFrame(() => {
      const el = textRef.current;
      el?.focus();
      el?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editingText]);

  /* ---- pointer pipeline -------------------------------------------------- */

  const commitText = useCallback(() => {
    const id = editingText;
    setEditingText(null);
    if (!id) return;
    // An empty text box is a mis-tap, not an annotation.
    const s = doc.shapes.find((x) => x.id === id);
    if (s && s.kind === "text" && !s.text.trim()) doc.discard();
  }, [doc, editingText]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (busy) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const p = pointOf(e);
      pointers.current.set(e.pointerId, p);

      // Two fingers always mean navigate, never draw — including mid-stroke, so
      // a second finger landing during a drag rescues the gesture instead of
      // scribbling. The half-drawn shape is dropped with its history entry.
      if (pointers.current.size === 2) {
        if (drag.current.kind === "draw") doc.discard();
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        drag.current = { kind: "pinch", startDist: vpm.distance(a, b), startScale: vp.scale };
        return;
      }
      if (pointers.current.size > 2) return;
      if (editingText) commitText();

      const [ix, iy] = imageOf(p);

      if (mode === "crop") {
        const corner = cropCornerAt(p);
        if (corner) {
          drag.current = { kind: "crop-handle", corner };
        } else if (ix >= crop.x && ix <= crop.x + crop.w && iy >= crop.y && iy <= crop.y + crop.h) {
          drag.current = { kind: "crop-move", last: [ix, iy] };
        } else {
          drag.current = { kind: "crop-new", origin: [ix, iy] };
          setCrop({ x: ix, y: iy, w: 0, h: 0 });
        }
        return;
      }

      if (tool === "select") {
        const node = stageRef.current?.getIntersection(p);
        const name = node?.name();
        if (name?.startsWith("handle:") && selectedId) {
          drag.current = { kind: "handle", id: selectedId, handle: name.slice(7), marked: false };
          return;
        }
        const hitId = node?.id();
        const hit = hitId ? doc.shapes.find((s) => s.id === hitId) : undefined;
        if (hit) {
          setSelectedId(hit.id);
          drag.current = { kind: "move", id: hit.id, last: [ix, iy], marked: false };
          return;
        }
        setSelectedId(null);
        drag.current = { kind: "pan", last: p };
        return;
      }

      setSelectedId(null);
      doc.mark();
      const shape = createShape(tool, ix, iy);
      doc.edit((d) => ({ shapes: [...d.shapes, shape] }));
      if (tool === "text") {
        setEditingText(shape.id);
        drag.current = { kind: "none" };
      } else {
        drag.current = { kind: "draw", id: shape.id, moved: false };
      }
    },
    [
      busy,
      commitText,
      createShape,
      crop,
      cropCornerAt,
      doc,
      editingText,
      imageOf,
      mode,
      pointOf,
      selectedId,
      tool,
      vp.scale,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      const p = pointOf(e);
      pointers.current.set(e.pointerId, p);
      const d = drag.current;

      if (d.kind === "pinch") {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const mid = vpm.midpoint(a, b);
        const ratio = vpm.distance(a, b) / (d.startDist || 1);
        setVp((v) => vpm.zoomAt(v, d.startScale * ratio, mid.x, mid.y, frame, box));
        return;
      }

      const [ix, iy] = imageOf(p);

      switch (d.kind) {
        case "pan":
          setVp((v) =>
            vpm.clampPan({ ...v, x: v.x + (p.x - d.last.x), y: v.y + (p.y - d.last.y) }, frame, box),
          );
          d.last = p;
          return;

        case "draw": {
          d.moved = true;
          patch(d.id, (s) => {
            if (s.kind === "pen" || s.kind === "highlight") {
              const n = s.points.length;
              const dx = ix - s.points[n - 2]!;
              const dy = iy - s.points[n - 1]!;
              // `* vp.scale` converts the image-space step into the screen-space
              // one the threshold is defined in — see DECIMATE.
              if (Math.hypot(dx, dy) * vp.scale < DECIMATE) return s;
              return { ...s, points: [...s.points, ix, iy] };
            }
            if (s.kind === "arrow") return { ...s, x2: ix, y2: iy };
            if (isBox(s)) return { ...s, ...normalize({ x: s.x, y: s.y, w: ix - s.x, h: iy - s.y }) };
            return s;
          });
          return;
        }

        case "move": {
          const dx = ix - d.last[0];
          const dy = iy - d.last[1];
          d.last = [ix, iy];
          if (!d.marked) {
            doc.mark();
            d.marked = true;
          }
          patch(d.id, (s) => translate(s, dx, dy));
          return;
        }

        case "handle":
          if (!d.marked) {
            doc.mark();
            d.marked = true;
          }
          patch(d.id, (s) => resize(s, d.handle, ix, iy));
          return;

        case "crop-new":
          setCrop(
            clampRect(
              normalize({ x: d.origin[0], y: d.origin[1], w: ix - d.origin[0], h: iy - d.origin[1] }),
              frame.width,
              frame.height,
            ),
          );
          return;

        case "crop-move": {
          const dx = ix - d.last[0];
          const dy = iy - d.last[1];
          d.last = [ix, iy];
          const bounds = { w: frame.width, h: frame.height };
          setCrop((c) => ({
            ...c,
            x: Math.max(0, Math.min(c.x + dx, bounds.w - c.w)),
            y: Math.max(0, Math.min(c.y + dy, bounds.h - c.h)),
          }));
          return;
        }

        case "crop-handle": {
          const bounds = { w: frame.width, h: frame.height };
          setCrop((c) => {
            const x2 = c.x + c.w;
            const y2 = c.y + c.h;
            const next = d.corner.includes("n")
              ? { top: iy, bottom: y2 }
              : { top: c.y, bottom: iy };
            const horiz = d.corner.includes("w")
              ? { left: ix, right: x2 }
              : { left: c.x, right: ix };
            return clampRect(
              normalize({
                x: horiz.left,
                y: next.top,
                w: horiz.right - horiz.left,
                h: next.bottom - next.top,
              }),
              bounds.w,
              bounds.h,
            );
          });
          return;
        }

        default:
          return;
      }
    },
    [box, doc, frame, imageOf, patch, pointOf, vp.scale],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      pointers.current.delete(e.pointerId);
      const d = drag.current;
      if (pointers.current.size > 0) {
        // Lifting one finger of a pinch: re-seat the remaining one as a pan
        // origin so the image does not jump by the gap between the two.
        if (d.kind === "pinch") {
          const rest = [...pointers.current.values()][0];
          drag.current = rest ? { kind: "pan", last: rest } : { kind: "none" };
        }
        return;
      }

      if (d.kind === "draw") {
        const s = doc.shapes.find((x) => x.id === d.id);
        const tiny =
          !d.moved ||
          (s && s.kind === "arrow" && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * vp.scale < MIN_DRAG) ||
          (s && isBox(s) && (s.w * vp.scale < MIN_DRAG || s.h * vp.scale < MIN_DRAG));
        // A pen tap is a legitimate dot; a rectangle tap is a mis-click.
        const isDot = s && (s.kind === "pen" || s.kind === "highlight");
        if (tiny && !isDot) doc.discard();
      }
      drag.current = { kind: "none" };
    },
    [doc, vp.scale],
  );

  /**
   * Double-click an existing text annotation to edit it again. Without this the
   * only way to fix a typo is delete-and-retype, which is what everyone tries
   * second after double-clicking it and getting nothing.
   */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "markup" || busy) return;
      const r = boxRef.current?.getBoundingClientRect();
      const p = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
      const hitId = stageRef.current?.getIntersection(p)?.id();
      const hit = hitId ? doc.shapes.find((s) => s.id === hitId) : undefined;
      if (!hit || hit.kind !== "text") return;
      setSelectedId(hit.id);
      // Opens a step so the whole re-edit undoes in one press, and so blanking
      // the field can `discard()` back to the original wording.
      doc.mark();
      setEditingText(hit.id);
    },
    [busy, doc, mode],
  );

  /* ---- crop mode --------------------------------------------------------- */

  const enterCrop = useCallback(() => {
    setSelectedId(null);
    setTurns(0);
    setStraighten(0);
    setFlipH(false);
    setFlipV(false);
    setCrop({ x: 0, y: 0, w: image.width, h: image.height });
    setMode("crop");
  }, [image]);

  // Any change of angle rebuilds the frame the crop lives in, so re-seat the
  // crop on the largest rectangle that excludes the wedges a straighten opens.
  const setAngleParts = useCallback(
    (nextTurns: number, nextStraighten: number) => {
      setTurns(nextTurns);
      setStraighten(nextStraighten);
      const a = nextTurns * 90 + nextStraighten;
      setCrop(
        a % 90 === 0
          ? (() => {
              const b = rotatedBounds(image.width, image.height, a);
              return { x: 0, y: 0, w: b.w, h: b.h };
            })()
          : insetCrop(image.width, image.height, a),
      );
    },
    [image],
  );

  const applyCrop = useCallback(() => {
    const bounds = rotatedBounds(image.width, image.height, angle);
    const rect = clampRect(normalize(crop), bounds.w, bounds.h);
    if (rect.w < 1 || rect.h < 1) {
      setMode("markup");
      return;
    }
    // Entering crop and pressing Crop straight back out is not an edit. Baking
    // it anyway would re-encode the whole bitmap, keep the old one alive in the
    // undo stack, and leave a step that undoes to an identical picture.
    const noop =
      angle % 360 === 0 &&
      !flipH &&
      !flipV &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.w === image.width &&
      rect.h === image.height;
    if (noop) {
      setMode("markup");
      return;
    }
    const op: BakeOp = { angle, flipH, flipV, crop: rect };
    doc.mark();
    const nextBase = bakeImage(doc.base, op);
    doc.edit((d) => ({
      base: nextBase,
      shapes: bakeShapes(op, image.width, image.height, d.shapes),
    }));
    setMode("markup");
  }, [angle, crop, doc, flipH, flipV, image]);

  /* ---- keyboard ---------------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");
      if (e.key === "Escape") {
        if (typing) return; // the textarea's own handler commits it
        if (mode === "crop") setMode("markup");
        else onCancel();
        return;
      }
      if (typing) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doc.redo();
        else doc.undo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        doc.mark();
        doc.edit((d) => ({ shapes: d.shapes.filter((s) => s.id !== selectedId) }));
        setSelectedId(null);
        return;
      }
      if (mode !== "markup") return;
      // Single-key tool switching, the convention every markup tool shares.
      const keys: Record<string, ToolId> = {
        v: "select",
        p: "pen",
        h: "highlight",
        a: "arrow",
        r: "rect",
        e: "ellipse",
        t: "text",
        x: "redact",
      };
      const next = keys[e.key.toLowerCase()];
      if (next && !meta) {
        setTool(next);
        return;
      }
      if (e.key === "0") doFit();
      if (e.key === "=" || e.key === "+") zoomBy(1.25);
      if (e.key === "-") zoomBy(1 / 1.25);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, doFit, doc, mode, onCancel, selectedId, zoomBy]);

  /* ---- apply ------------------------------------------------------------- */

  const apply = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    setBusy(true);
    setError(null);
    // Drop the selection first: its dashed box and handles are UI, and they are
    // in the same layer the export reads.
    setSelectedId(null);
    try {
      // A frame, so React has painted the deselect before the stage is read.
      await new Promise(requestAnimationFrame);
      const dataUrl = exportStage(stage, image.width, image.height);
      const ref = await uploadChatImage(chatId, dataUrl, {
        alt,
        width: image.width,
        height: image.height,
      });
      onApply(ref);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not save the edited image.");
    }
  }, [alt, chatId, image, onApply]);

  /* ---- style edits ------------------------------------------------------- */

  const applyStyle = useCallback(
    (p: { color?: string; width?: number }) => {
      setStyle(styleKind, p);
      if (!selected) return;
      doc.mark();
      patch(selected.id, (s) => {
        if (s.kind === "text")
          return { ...s, color: p.color ?? s.color, fontSize: p.width ?? s.fontSize };
        return { ...s, color: p.color ?? s.color, width: p.width ?? s.width };
      });
    },
    [doc, patch, selected, setStyle, styleKind],
  );

  const textShape = editingText ? doc.shapes.find((s) => s.id === editingText) : null;

  /**
   * Live preview of the pending rotate/flip, as a Konva group transform. It is
   * the on-screen twin of `bakeImage`: same centre, same order, so pressing
   * Crop bakes precisely the framing that was visible.
   */
  const previewTransform =
    mode === "crop"
      ? {
          x: frame.width / 2,
          y: frame.height / 2,
          rotation: angle,
          offsetX: image.width / 2,
          offsetY: image.height / 2,
          scaleX: flipH ? -1 : 1,
          scaleY: flipV ? -1 : 1,
        }
      : // Explicit identity rather than an empty object: leaving these props off
        // relies on react-konva resetting a prop that has disappeared, and a
        // group stuck at the last rotation would bake a wrong export.
        { x: 0, y: 0, rotation: 0, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

  return (
    <>
      <header className="flex items-center gap-2.5 px-3 py-2.5 cm-hairline-b sm:px-4 sm:py-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
          {mode === "crop" ? <CropIcon /> : <Check />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-primary sm:text-base">
            {mode === "crop" ? "Crop & rotate" : "Edit image"}
          </h2>
          <p className="mt-px hidden truncate text-xs text-muted sm:block">
            {mode === "crop"
              ? "Drag to set the crop; rotate or straighten below."
              : "Scroll or pinch to zoom · two fingers to pan · V to select"}
          </p>
        </div>

        {mode === "markup" ? (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={busy ? <Spinner size={13} /> : <Check />}
              onClick={apply}
              // Nothing drawn means Apply would upload a byte-identical copy as
              // a NEW asset and orphan the original — a no-op that costs disk.
              disabled={busy || !doc.dirty}
            >
              {busy ? "Saving…" : "Apply"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setMode("markup")}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" leftIcon={<Check />} onClick={applyCrop}>
              Crop
            </Button>
          </div>
        )}
      </header>

      {error && (
        <div
          className="flex items-center gap-1.5 bg-danger-ghost px-4 py-2 text-xs text-danger [&_svg]:size-3.5"
          role="alert"
        >
          <ImageOff />
          {error}
        </div>
      )}

      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-inset",
          // The browser must not claim the gesture: without this, a one-finger
          // drag scrolls the page instead of drawing, and a pinch zooms the
          // whole app. This is the single most important line for touch.
          "touch-none select-none",
          "sm:h-[min(68vh,720px)] sm:flex-none",
          mode === "crop"
            ? "cursor-crosshair"
            : tool === "select"
              ? "cursor-default"
              : "cursor-crosshair",
        )}
      >
        {/* The viewport transform lives on the STAGE, not on the layer, because
            `exportStage` resets the stage to 1:1 to read the PNG at natural
            size. On the layer it would survive that reset and every export
            would come out at whatever zoom happened to be on screen. */}
        <Stage
          ref={stageRef}
          width={box.width}
          height={box.height}
          scaleX={vp.scale}
          scaleY={vp.scale}
          x={vp.x}
          y={vp.y}
        >
          {/* One layer: the export reads the stage, so anything that must appear
              in the PNG has to live here. Overlays are removed before export
              rather than parked in a second layer. */}
          <Layer imageSmoothingEnabled>
            {/* In crop mode this group reproduces BakeOp's flip-then-rotate
                EXACTLY (Konva applies offset, then scale, then rotation, then
                position), so what you frame is what gets baked. In markup mode
                it is the identity and the export is untouched by it. */}
            <Group {...previewTransform}>
              <KonvaImage
                image={doc.base}
                width={image.width}
                height={image.height}
                listening={false}
              />
              {doc.shapes.map((s) =>
                // The one being edited is drawn by the textarea instead, or the
                // two render on top of each other at slightly different metrics.
                s.id === editingText ? null : (
                  <ShapeNode key={s.id} shape={s} listening={mode === "markup" && tool === "select"} />
                ),
              )}
            </Group>
            {mode === "markup" && selected && !busy && (
              <SelectionOverlay shape={selected} scale={vp.scale} accent={accent} />
            )}
            {mode === "crop" && (
              <CropOverlay
                crop={crop}
                imageWidth={frame.width}
                imageHeight={frame.height}
                scale={vp.scale}
                accent={accent}
              />
            )}
          </Layer>
        </Stage>

        {/* Live text entry, positioned over the shape it edits.
            It sits INSIDE the box that owns the pointer pipeline, so every
            pointer event has to be stopped here: without that, clicking into
            the field reaches the container's onPointerDown, which commits the
            (still empty) shape and unmounts the field out from under the
            caret — the box appeared and then died on first click. */}
        {textShape && textShape.kind === "text" && (
          <textarea
            // Keyed per shape so a second text box actually mounts, and so the
            // focus effect below re-runs for it rather than leaving the caret
            // in the previous one.
            key={textShape.id}
            ref={textRef}
            value={textShape.text}
            onChange={(e) => patch(textShape.id, (s) => ({ ...s, text: e.target.value }) as Shape)}
            onBlur={commitText}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            placeholder="Type…"
            // `select-text` undoes the box's `select-none`, which otherwise
            // makes the caret and drag-selection behave like a dead element.
            className={cn(
              "absolute resize-none select-text rounded-sm border border-accent bg-panel/95",
              "px-1 py-0.5 text-primary shadow-[var(--shadow-pop)] outline-none",
            )}
            style={{
              left: vpm.toScreen(vp, textShape.x, textShape.y)[0],
              top: vpm.toScreen(vp, textShape.x, textShape.y)[1],
              fontSize: Math.max(12, textShape.fontSize * vp.scale),
              lineHeight: 1.2,
              minWidth: 120,
              // Matches the Konva Text node so the box is not a different shape
              // to the thing it is editing.
              color: textShape.color,
              fontWeight: 600,
            }}
          />
        )}

        <ZoomControls scale={vp.scale} onIn={() => zoomBy(1.25)} onOut={() => zoomBy(1 / 1.25)} onFit={doFit} />
      </div>

      {mode === "markup" ? (
        <Toolbar
          tool={tool}
          onTool={setTool}
          styleKind={styleKind}
          color={selected ? shapeColor(selected) : activeStyle.color}
          width={selected ? shapeWidth(selected) : activeStyle.width}
          onColor={(color) => applyStyle({ color })}
          onWidth={(width) => applyStyle({ width })}
          onCrop={enterCrop}
          onUndo={doc.undo}
          onRedo={doc.redo}
          onDelete={() => {
            if (!selectedId) return;
            doc.mark();
            doc.edit((d) => ({ shapes: d.shapes.filter((s) => s.id !== selectedId) }));
            setSelectedId(null);
          }}
          canUndo={doc.canUndo}
          canRedo={doc.canRedo}
          canDelete={!!selectedId}
        />
      ) : (
        <CropBar
          straighten={straighten}
          onStraighten={(v) => setAngleParts(turns, v)}
          onTurn={(delta) => setAngleParts(turns + delta, straighten)}
          flipH={flipH}
          flipV={flipV}
          onFlipH={() => setFlipH((v) => !v)}
          onFlipV={() => setFlipV((v) => !v)}
        />
      )}
    </>
  );
}

/* ---- small pieces -------------------------------------------------------- */

function ZoomControls({
  scale,
  onIn,
  onOut,
  onFit,
}: {
  scale: number;
  onIn: () => void;
  onOut: () => void;
  onFit: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 backdrop-blur-sm">
      <IconButton size="md" tip="Zoom out" onClick={onOut}>
        <ZoomOut />
      </IconButton>
      {/* The readout is also the Fit button — the number tells you what pressing
          it will change, which a lone icon does not. */}
      <Button variant="ghost" size="sm" onClick={onFit} className="cm-mono min-w-[3.5rem] !text-2xs">
        {Math.round(scale * 100)}%
      </Button>
      <IconButton size="md" tip="Zoom in" onClick={onIn}>
        <ZoomIn />
      </IconButton>
      <IconButton size="md" tip="Fit to window" onClick={onFit}>
        <Maximize2 />
      </IconButton>
    </div>
  );
}

function CropBar({
  straighten,
  onStraighten,
  onTurn,
  flipH,
  flipV,
  onFlipH,
  onFlipV,
}: {
  straighten: number;
  onStraighten: (v: number) => void;
  onTurn: (delta: number) => void;
  flipH: boolean;
  flipV: boolean;
  onFlipH: () => void;
  onFlipV: () => void;
}) {
  return (
    <div className="cm-hairline-t flex flex-wrap items-center gap-2 bg-panel px-3 py-2.5">
      <IconButton tip="Rotate left" onClick={() => onTurn(-1)}>
        <RotateCcw />
      </IconButton>
      <IconButton tip="Rotate right" onClick={() => onTurn(1)}>
        <RotateCw />
      </IconButton>
      <IconButton tip="Flip horizontally" active={flipH} onClick={onFlipH}>
        <FlipHorizontal2 />
      </IconButton>
      <IconButton tip="Flip vertically" active={flipV} onClick={onFlipV}>
        <FlipVertical2 />
      </IconButton>

      <span className="mx-1 h-6 w-px bg-line" aria-hidden />

      <label className="flex min-w-[180px] flex-1 items-center gap-2 text-xs text-muted">
        <span className="shrink-0">Straighten</span>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.5}
          value={straighten}
          onChange={(e) => onStraighten(Number(e.target.value))}
          className="h-1 flex-1 accent-[var(--p-accent)]"
        />
        <span className="cm-mono w-10 shrink-0 text-right text-2xs text-secondary">
          {straighten.toFixed(1)}°
        </span>
      </label>

      {straighten !== 0 && (
        <Button variant="ghost" size="sm" leftIcon={<X />} onClick={() => onStraighten(0)}>
          Reset
        </Button>
      )}
    </div>
  );
}

/* ---- shape maths --------------------------------------------------------- */

function shapeColor(s: Shape): string {
  return s.color;
}

function shapeWidth(s: Shape): number {
  return s.kind === "text" ? s.fontSize : s.width;
}

function translate(s: Shape, dx: number, dy: number): Shape {
  switch (s.kind) {
    case "pen":
    case "highlight":
      return { ...s, points: s.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    case "arrow":
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    default:
      return { ...s, x: s.x + dx, y: s.y + dy };
  }
}

/** Drag one handle to its new image-space position. */
function resize(s: Shape, handle: string, x: number, y: number): Shape {
  if (s.kind === "arrow") {
    return handle === "p1" ? { ...s, x1: x, y1: y } : { ...s, x2: x, y2: y };
  }
  if (!isBox(s)) return s;
  const left = handle.includes("w") ? x : s.x;
  const right = handle.includes("e") ? x : s.x + s.w;
  const top = handle.includes("n") ? y : s.y;
  const bottom = handle.includes("s") ? y : s.y + s.h;
  return { ...s, ...normalize({ x: left, y: top, w: right - left, h: bottom - top }) };
}
