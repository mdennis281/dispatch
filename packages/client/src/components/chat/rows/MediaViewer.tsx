import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { mediaKind, type ImageRef } from "@dispatch/shared";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { useDialogLayer } from "../../../lib/layers.js";
import { cn } from "../../../lib/cn.js";
import { canCopyImages, copyImageToClipboard, type CopyResult } from "../../../lib/clipboardImage.js";
import * as vp from "../../../lib/imageViewport.js";
import { useAssetSrc } from "../../../lib/assetSrc.js";
import { Spinner } from "../../ui/Spinner.js";

/** The filename part of an asset path, for the caption and the download name. */
export function assetName(asset: ImageRef): string {
  return asset.alt ?? asset.path.split(/[\\/]/).pop() ?? asset.path;
}

/**
 * Full-screen viewer for chat media.
 *
 * Replaces a lightbox that could only do `object-fit: contain` and a download
 * link. The gap that mattered: an agent's screenshot is routinely 3000px wide,
 * so "the whole thing, scaled to fit" showed detail too small to read and there
 * was no way to get closer. Now it zooms (wheel, pinch, buttons, double-click),
 * pans, and toggles between fit and 1:1 — the arithmetic is
 * {@link module:lib/imageViewport}, shared with the annotator rather than
 * written twice.
 *
 * `assets` is the gallery, and by default that is EVERY image in the chat —
 * see `useChatMedia`. Opening a screenshot and pressing → should reach the next
 * screenshot, not stop dead because that tool call happened to return one
 * image. Only the CURRENT one is resolved to bytes, so a chat with thirty
 * screenshots does not fetch thirty blobs because one was clicked.
 *
 * The ends STOP rather than wrap. Wrapping made "next" silently jump back to
 * the oldest picture, which reads as the viewer having lost your place; a
 * disabled button says "that was the last one" without you having to work it
 * out.
 */
export function MediaViewer({
  chatId,
  assets,
  path,
  onClose,
}: {
  chatId: string;
  assets: ImageRef[];
  /** Which image to show. Identifies it by PATH, not by position — see below. */
  path?: string;
  onClose: () => void;
}) {
  const z = useDialogLayer();
  // The current image is tracked by PATH, and the index is derived from it.
  //
  // Position alone cannot survive the gallery being REPLACED. It opens on the
  // row's own images and is swapped for the chat-wide list a moment later, at
  // which point a stored index points at a different picture: clicking the
  // third of five showed "1/5", because index 0 was seeded before the real
  // gallery arrived and nothing re-seated it. A path re-locates itself.
  const [activePath, setActivePath] = useState<string | undefined>(
    () => path ?? assets[0]?.path,
  );
  const index = Math.max(
    assets.findIndex((a) => a.path === activePath),
    0,
  );
  const asset = assets[index];
  const { src, failed: loadFailed } = useAssetSrc(chatId, asset);
  const item = asset
    ? {
        src: src ?? "",
        name: assetName(asset),
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      }
    : undefined;
  const items = assets;

  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<vp.Box>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<vp.Box | null>(null);
  const [view, setView] = useState<vp.Viewport | null>(null);
  const [copied, setCopied] = useState<CopyResult | null>(null);
  const [failed, setFailed] = useState(false);

  const kind = mediaKind(item?.mimeType);
  // Only a still image is zoomable. A video gets native controls, which own
  // their own pointer handling and must not be fighting a pan gesture.
  const zoomable = kind === "image";

  // ---- measuring -----------------------------------------------------------

  // Layout effect, not effect: the first paint must already know the box, or
  // the image visibly jumps from unpositioned to fitted.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (): void =>
      setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit whenever the image or the box changes. Also the reset path for
  // stepping to the next item: `natural` changes, so the new one opens fitted.
  useEffect(() => {
    if (!natural || !box.width || !box.height) return;
    setView(vp.fit(natural, box));
  }, [natural, box.width, box.height]);

  // A new item invalidates the measured size; clearing it prevents one frame of
  // the new image drawn at the old one's scale.
  useEffect(() => {
    setNatural(null);
    setView(null);
    setFailed(false);
    setCopied(null);
  }, [asset?.path]);

  const onImgLoad = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    // An SVG with no intrinsic size reports 0. Fall back to the box so it is
    // laid out at something sensible rather than collapsing to nothing.
    setNatural({
      width: el.naturalWidth || box.width || 1,
      height: el.naturalHeight || box.height || 1,
    });
  }, [box.width, box.height]);

  // ---- zoom / pan ----------------------------------------------------------

  const applyZoom = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setView((prev) => {
        if (!prev || !natural) return prev;
        const el = boxRef.current;
        const rect = el?.getBoundingClientRect();
        // Default anchor is the centre of the box — what the +/- buttons and
        // the keyboard should zoom around, since they have no cursor.
        const ax = at && rect ? at.x - rect.left : box.width / 2;
        const ay = at && rect ? at.y - rect.top : box.height / 2;
        // `zoomAt` takes the ABSOLUTE next scale; everything here speaks in
        // factors (a wheel notch, a button press), so multiply through.
        return vp.zoomAt(prev, prev.scale * factor, ax, ay, natural, box);
      });
    },
    [natural, box],
  );

  const reset = useCallback(() => {
    if (natural && box.width) setView(vp.fit(natural, box));
  }, [natural, box]);

  const actualSize = useCallback(() => {
    setView((prev) => {
      if (!prev || !natural) return prev;
      return vp.clampPan(vp.centered(1, natural, box), natural, box);
    });
  }, [natural, box]);

  // Wheel zoom, bound natively so it can be non-passive. React's onWheel is
  // registered passively, where preventDefault is ignored — without it the page
  // behind the scrim scrolls while you are zooming.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !zoomable) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      applyZoom(vp.wheelFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, zoomable]);

  // Drag to pan, and pinch to zoom, over one pointer-event pipeline.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!zoomable) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = a && b ? vp.distance(a, b) : null;
    }
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!zoomable || !pointers.current.has(e.pointerId)) return;
    const prevPoint = pointers.current.get(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...pointers.current.values()];

    if (points.length >= 2 && pinch.current !== null) {
      const [a, b] = points;
      if (!a || !b) return;
      const dist = vp.distance(a, b);
      if (pinch.current > 0) {
        const mid = vp.midpoint(a, b);
        applyZoom(dist / pinch.current, mid);
      }
      pinch.current = dist;
      return;
    }

    if (!prevPoint) return;
    const dx = e.clientX - prevPoint.x;
    const dy = e.clientY - prevPoint.y;
    setView((prev) => {
      if (!prev || !natural) return prev;
      return vp.clampPan({ ...prev, x: prev.x + dx, y: prev.y + dy }, natural, box);
    });
  };

  const endPointer = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  // ---- actions -------------------------------------------------------------

  const step = useCallback(
    (delta: number) => {
      // CLAMPED, not wrapped. See the component doc: at the last image, → does
      // nothing and its button is disabled, rather than teleporting you back to
      // the first and looking like a lost position.
      const next = Math.min(Math.max(index + delta, 0), Math.max(items.length - 1, 0));
      setActivePath(items[next]?.path);
    },
    [index, items],
  );

  const copy = useCallback(async () => {
    if (!src) return;
    setCopied(await copyImageToClipboard(src, asset?.mimeType));
  }, [src, asset?.mimeType]);

  // Clear the copy confirmation on its own, so the button doesn't sit on a
  // stale "Copied" the next time it's looked at.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case "Escape":
          onClose();
          return;
        case "ArrowRight":
          step(1);
          return;
        case "ArrowLeft":
          step(-1);
          return;
        case "+":
        case "=":
          applyZoom(1.25);
          return;
        case "-":
        case "_":
          applyZoom(1 / 1.25);
          return;
        case "0":
          reset();
          return;
        case "1":
          actualSize();
          return;
        case "c":
          // Only when the user isn't trying to copy a text selection.
          if ((e.ctrlKey || e.metaKey) && !window.getSelection()?.toString()) void copy();
          return;
        default:
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, step, applyZoom, reset, actualSize, copy]);

  if (!item || !asset) return null;
  const broken = failed || loadFailed;

  const dims =
    natural?.width && natural.height
      ? `${Math.round(natural.width)}×${Math.round(natural.height)}`
      : item.width && item.height
        ? `${item.width}×${item.height}`
        : undefined;
  const zoomPct = view && natural ? Math.round(view.scale * 100) : null;

  // `cm-safe-pad`: the scrim is this element, so the insets go on as padding —
  // the dim still covers the whole screen and only the chrome moves clear of
  // the status bar, the home indicator, and (on the installed desktop window)
  // the system's own minimise/maximise/close buttons. This header is the reason
  // that last one is in there: it is the only surface in the app that puts
  // interactive controls at y=0 across the full width, so with the window
  // controls overlay up its right-hand end — including Close — was underneath
  // the OS buttons and unclickable.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
      style={{ zIndex: z }}
      className="fixed inset-0 flex flex-col bg-scrim-strong backdrop-blur-[2px] cm-safe-pad"
      onClick={onClose}
    >
      <header
        className="flex items-center gap-1.5 px-3 py-2.5 text-secondary"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-secondary">{item.name}</span>
        {items.length > 1 && (
          <span data-testid="viewer-position" className="cm-mono shrink-0 !text-2xs text-faint">
            {index + 1}/{items.length}
          </span>
        )}
        {dims && <span className="cm-mono shrink-0 !text-2xs text-faint">{dims}</span>}

        {zoomable && (
          <>
            <span className="cm-mono w-11 shrink-0 text-right !text-2xs text-faint">
              {zoomPct === null ? "" : `${zoomPct}%`}
            </span>
            <IconButton tip="Zoom out  (−)" onClick={() => applyZoom(1 / 1.25)}>
              <Minus />
            </IconButton>
            <IconButton tip="Zoom in  (+)" onClick={() => applyZoom(1.25)}>
              <Plus />
            </IconButton>
            <IconButton tip="Fit  (0)" onClick={reset}>
              <Maximize2 />
            </IconButton>
          </>
        )}

        {zoomable && canCopyImages() && (
          <IconButton
            tip={
              copied === "copied"
                ? "Copied"
                : copied === "failed"
                  ? "Copy failed"
                  : "Copy image  (Ctrl+C)"
            }
            onClick={() => void copy()}
          >
            {copied === "copied" ? <Check /> : <Copy />}
          </IconButton>
        )}
        <a
          href={item.src}
          target="_blank"
          rel="noreferrer"
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-active hover:text-primary [&_svg]:size-4"
          title="Open in new tab"
          aria-label="Open in new tab"
        >
          <ExternalLink />
        </a>
        <a
          href={item.src}
          download={item.name}
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-active hover:text-primary [&_svg]:size-4"
          title="Download"
          aria-label="Download"
        >
          <Download />
        </a>
        <IconButton tip="Close  (Esc)" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      {/* The whole media row swallows clicks. A DISABLED nav button has
          `pointer-events: none` (Button applies it), so a click at either end
          of the gallery passes straight through it — and without this it would
          reach the scrim, whose handler closes. That is the original "pressing
          next just closes the image", reappearing precisely at the boundary
          where the button is dead. Stopping here covers the button, the gaps
          around it, and anything added to this row later. */}
      <div
        className="flex min-h-0 flex-1 items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {items.length > 1 && (
          <NavButton side="left" disabled={index === 0} onClick={() => step(-1)}>
            <ChevronLeft />
          </NavButton>
        )}

        <div
          ref={boxRef}
          className={cn(
            "relative h-full min-h-0 min-w-0 flex-1 overflow-hidden",
            zoomable && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          // Toggle between fit and 1:1 — the gesture everyone already expects
          // from an image viewer, and the fastest way to inspect a screenshot.
          onDoubleClick={() =>
            view && natural && Math.abs(view.scale - 1) < 0.01 ? reset() : actualSize()
          }
          // The browser's own pan/zoom would fight ours on a touchscreen.
          style={{ touchAction: zoomable ? "none" : undefined }}
        >
          {broken ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
              Could not load {item.name}
            </div>
          ) : !src ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={18} />
            </div>
          ) : kind === "video" ? (
            <video
              src={item.src}
              controls
              autoPlay
              className="absolute inset-0 m-auto max-h-full max-w-full bg-black"
              onError={() => setFailed(true)}
            />
          ) : kind === "audio" ? (
            <div className="flex h-full items-center justify-center p-6">
              <audio src={item.src} controls autoPlay className="w-full max-w-[480px]" />
            </div>
          ) : (
            <img
              ref={imgRef}
              src={item.src}
              alt={item.name}
              onLoad={onImgLoad}
              onError={() => setFailed(true)}
              draggable={false}
              // Positioned by the viewport transform rather than by layout, so
              // zoom and pan are one composited change instead of a reflow.
              style={
                view
                  ? {
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                      transformOrigin: "0 0",
                      // Above 1:1 the user asked to see PIXELS. Smoothing them
                      // is the browser inventing detail that isn't in the file.
                      imageRendering: view.scale > 1.5 ? "pixelated" : undefined,
                    }
                  : { opacity: 0 }
              }
              className="absolute left-0 top-0 max-w-none select-none shadow-[var(--shadow-pop)]"
            />
          )}
        </div>

        {items.length > 1 && (
          <NavButton
            side="right"
            disabled={index >= items.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight />
          </NavButton>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Prev/next affordance.
 *
 * A FLEX SIBLING of the image surface, not an overlay on top of it. Floating
 * them over the picture meant their hit area overlapped the pan surface, and a
 * click that missed by a pixel — or landed mid-re-render, when the image is
 * being swapped — fell through to the scrim, whose job is to CLOSE. "Pressing
 * next just closes the image" was exactly that. Sibling layout makes the
 * overlap impossible rather than merely unlikely, and has the side benefit that
 * the controls never sit on top of the thing you are trying to look at.
 */
function NavButton({
  side,
  onClick,
  disabled,
  children,
}: {
  side: "left" | "right";
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      circle
      size="md"
      aria-label={side === "left" ? "Previous" : "Next"}
      disabled={disabled}
      onClick={(e) => {
        // Always stop the bubble, even when disabled has already swallowed the
        // click: this button sits on the scrim, whose click handler CLOSES the
        // viewer. That is what made "press next at the end" look like "next
        // closes the image".
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        // Floated over the media rather than taking a column of width, and
        // translucent so it never hides the part of the image it sits on.
        "mx-2 shrink-0 bg-panel/80 backdrop-blur [&_svg]:size-5",
      )}
    >
      {children}
    </Button>
  );
}
