/**
 * Image markup editor — a full markup surface for a composer attachment, opened
 * by clicking an attachment thumbnail before sending.
 *
 * Powered by two proven, framework-agnostic engines (we do NOT hand-roll a canvas
 * engine): marker.js 2 for annotation (freehand pen, rectangle, ellipse, arrow,
 * highlighter, text, colour + brush-width toolbox, undo/redo, delete/clear as an
 * eraser) and CROPRO for crop / rotate / flip / straighten. Both are mounted
 * imperatively onto a plain <img> the effect fully owns, so React never fights
 * them over the DOM. This whole module is lazy-loaded from the Composer so the
 * two engines land in their own chunk and never bloat the initial bundle.
 *
 * On Apply the annotated result is flattened to a PNG and re-uploaded through the
 * existing asset flow (POST /api/chats/:id/assets → ImageRef), returned to the
 * Composer which swaps it in place of the original attachment.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crop as CropIcon, Check, X, ImageOff, Pencil, RotateCcw } from "lucide-react";
import * as markerjs2 from "markerjs2";
import * as cropro from "cropro";
import type { ImageRef } from "@cm/shared";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { uploadChatImage } from "../../lib/actions.js";

/* Linear/Zed design tokens (mirrored from index.css) — the imperative engines
   render their own chrome, so we feed them the same hexes to stay on-palette. */
const INSET = "#0a0c0f";
const PANEL = "#111418";
const PANEL_2 = "#14181d";
const ELEVATED = "#171b21";
const PRIMARY = "#e6e8eb";
const ACCENT = "#7c8aff";
const ACCENT_HI = "#9aa5ff";
const DANGER = "#ec5f6a";

type Mode = "annotate" | "crop";

/** Fallbacks for the chrome reserve, used only if the engine's DOM moves. */
const TOOLBAR_H = 40;
const TOOLBOX_H = 96;
const CHROME_GAP = 8;

/**
 * marker.js floats its toolbar above the image and its colour/width toolbox
 * below it, positioning both from the image's own box. When the image fills the
 * host there's nowhere to put them, so they land ON the picture — that's the
 * colour swatches covering the bottom of the shot.
 *
 * Reserve exactly as much padding as the real chrome measures. The engine
 * observes the target <img> with a ResizeObserver, so shrinking the image
 * re-runs its layout and the chrome drops into the gap we just opened.
 *
 * Returns a teardown for the observer.
 */
function reserveChrome(host: HTMLElement, ma: InstanceType<typeof markerjs2.MarkerArea>) {
  const p = ma.styles.classNamePrefix;
  const bar = host.querySelector<HTMLElement>(`.${p}toolbar`);
  const box = host.querySelector<HTMLElement>(`.${p}toolbox`);
  const apply = () => {
    const top = `${(bar?.offsetHeight || TOOLBAR_H) + CHROME_GAP}px`;
    const bottom = `${(box?.offsetHeight || TOOLBOX_H) + CHROME_GAP}px`;
    // Guarded writes — the observer below must not feed itself.
    if (host.style.paddingTop !== top) host.style.paddingTop = top;
    if (host.style.paddingBottom !== bottom) host.style.paddingBottom = bottom;
  };
  apply();
  // The toolbox height follows the active tool's panel (a text marker's font row
  // is taller than the pen's width row) — keep the reserve in step with it.
  const ro = new ResizeObserver(apply);
  if (box) ro.observe(box);
  return () => ro.disconnect();
}

export interface ImageAnnotatorProps {
  chatId: string;
  /** Resolved URL of the attachment to edit (same-origin asset endpoint). */
  src: string;
  /** Carried onto the replacement ImageRef so the label survives an edit. */
  alt?: string;
  onCancel: () => void;
  onApply: (ref: ImageRef) => void;
}

/** Resolve once the <img> has decoded (so the engines size to it correctly). */
function decoded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not load image"));
  });
}

/** Natural pixel dimensions of a data/URL image, for the replacement ImageRef. */
function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve({ width: 0, height: 0 });
    probe.src = url;
  });
}

export default function ImageAnnotator({
  chatId,
  src,
  alt,
  onCancel,
  onApply,
}: ImageAnnotatorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const maRef = useRef<InstanceType<typeof markerjs2.MarkerArea> | null>(null);
  // `workingSrc` is the current base image: starts as the attachment, becomes a
  // flattened data-URL after each crop / on re-entering annotate.
  const [workingSrc, setWorkingSrc] = useState(src);
  const [mode, setMode] = useState<Mode>("annotate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape cancels (matches the app's Modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // Mount whichever engine the current mode needs onto a fresh <img> the effect
  // owns end-to-end. Re-runs when the mode or the base image changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ma: InstanceType<typeof markerjs2.MarkerArea> | null = null;
    let ca: InstanceType<typeof cropro.CropArea> | null = null;
    let releaseChrome: (() => void) | null = null;

    void (async () => {
      const img = document.createElement("img");
      img.src = workingSrc;
      img.alt = alt ?? "image";
      img.style.maxWidth = "100%";
      img.style.maxHeight = "100%";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.style.margin = "0 auto";
      try {
        await decoded(img);
      } catch {
        if (!disposed) setError("Could not load this image.");
        return;
      }
      if (disposed) return;
      host.replaceChildren(img);

      if (mode === "annotate") {
        ma = new markerjs2.MarkerArea(img);
        ma.targetRoot = host;
        ma.settings.displayMode = "inline";
        // One marker per stroke, so undo peels off the last stroke instead of
        // wiping everything drawn since the pen was picked up.
        ma.settings.newFreehandMarkerOnPointerUp = true;
        ma.availableMarkerTypes = [
          markerjs2.FreehandMarker,
          markerjs2.HighlightMarker,
          markerjs2.ArrowMarker,
          markerjs2.FrameMarker,
          markerjs2.EllipseFrameMarker,
          markerjs2.TextMarker,
        ];
        ma.renderAtNaturalSize = true;
        ma.renderImageType = "image/png";
        const s = ma.uiStyleSettings;
        s.canvasBackgroundColor = INSET;
        s.toolbarBackgroundColor = PANEL;
        s.toolbarBackgroundHoverColor = ELEVATED;
        s.toolbarColor = PRIMARY;
        s.toolboxBackgroundColor = PANEL_2;
        s.toolboxColor = PRIMARY;
        s.toolboxAccentColor = ACCENT;
        s.selectButtonColor = ACCENT_HI;
        s.deleteButtonColor = DANGER;
        s.undoButtonVisible = true;
        s.redoButtonVisible = true;
        s.clearButtonVisible = true;
        s.resultButtonBlockVisible = false; // our own Apply/Cancel drive the result
        s.logoPosition = "right";
        ma.show();
        maRef.current = ma;
        // Open on the pen. Without this the editor starts in select mode with
        // nothing selectable — every first drag on the image did nothing until
        // you found the pen button.
        ma.createNewMarker(markerjs2.FreehandMarker);
        releaseChrome = reserveChrome(host, ma);
      } else {
        ca = new cropro.CropArea(img);
        ca.targetRoot = host;
        ca.displayMode = "inline";
        ca.renderAtNaturalSize = true;
        ca.renderImageType = "image/png";
        const cs = ca.styles.settings;
        cs.canvasBackgroundColor = INSET;
        cs.toolbarBackgroundColor = PANEL;
        cs.toolbarBackgroundHoverColor = ELEVATED;
        cs.toolbarColor = PRIMARY;
        cs.cropFrameColor = ACCENT;
        cs.gripColor = ACCENT_HI;
        cs.gripFillColor = ACCENT;
        // CROPRO's render() is private — its own OK button fires this event.
        ca.addRenderEventListener((dataUrl: string) => {
          if (dataUrl) setWorkingSrc(dataUrl);
          setMode("annotate");
        });
        ca.addCloseEventListener(() => setMode("annotate"));
        ca.show();
      }
    })();

    return () => {
      disposed = true;
      releaseChrome?.();
      // Drop the measured reserve so the next mode starts from the CSS defaults.
      host.style.paddingTop = "";
      host.style.paddingBottom = "";
      try {
        ma?.close();
      } catch {
        /* engine already torn down */
      }
      try {
        ca?.close();
      } catch {
        /* engine already torn down */
      }
      maRef.current = null;
      host.replaceChildren();
    };
  }, [mode, workingSrc, alt]);

  // Flatten current annotations into the base image, then hand it to CROPRO.
  const enterCrop = useCallback(async () => {
    const ma = maRef.current;
    if (!ma) return;
    try {
      const flattened = await ma.render();
      setWorkingSrc(flattened);
      setMode("crop");
    } catch {
      setError("Could not prepare the image for cropping.");
    }
  }, []);

  const apply = useCallback(async () => {
    const ma = maRef.current;
    if (!ma) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await ma.render();
      const { width, height } = await measure(dataUrl);
      const ref = await uploadChatImage(chatId, dataUrl, {
        alt,
        width: width || undefined,
        height: height || undefined,
      });
      onApply(ref);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Could not save the edited image.");
    }
  }, [alt, chatId, onApply]);

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={() => !busy && onCancel()}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit image"
        className={
          "relative z-10 flex w-full max-w-[1080px] flex-col overflow-hidden rounded-lg " +
          "border border-line-strong bg-overlay/98 shadow-[var(--shadow-pop)] backdrop-blur-md cm-anim-rise"
        }
      >
        {/* header — our Linear/Zed chrome; the engines render their own tool rows */}
        <header className="flex items-center gap-2.5 px-4 py-3 cm-hairline-b">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
            {mode === "crop" ? <CropIcon /> : <Pencil />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold text-primary">
              {mode === "crop" ? "Crop & rotate" : "Edit image"}
            </h2>
            <p className="mt-px truncate text-[11px] text-muted">
              {mode === "crop"
                ? "Drag to crop, rotate/flip, then confirm with ✓"
                : "Pen is ready — just drag. Other tools above, colour & width below."}
            </p>
          </div>

          {mode === "annotate" ? (
            <div className="flex items-center gap-1.5">
              <Button variant="subtle" size="sm" leftIcon={<CropIcon />} onClick={enterCrop} disabled={busy}>
                Crop
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={busy ? <Spinner size={13} /> : <Check />}
                onClick={apply}
                disabled={busy}
              >
                {busy ? "Saving…" : "Apply"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="hidden items-center gap-1 text-[11px] text-faint sm:flex">
                <RotateCcw className="size-3.5" /> confirm with ✓
              </span>
              <IconButton tip="Close editor" onClick={onCancel}>
                <X />
              </IconButton>
            </div>
          )}
        </header>

        {error && (
          <div className="flex items-center gap-1.5 bg-danger-ghost px-4 py-2 text-[11.5px] text-danger [&_svg]:size-3.5" role="alert">
            <ImageOff />
            {error}
          </div>
        )}

        {/* editor host — the engines take over this box imperatively.
            marker.js2 / CROPRO float their toolbar ABOVE the image (at
            `image.offsetTop - toolbarHeight`) and their toolbox BELOW it. When
            the image is flush to the top of its box (a tall image centered in
            this host → offsetTop ≈ 0) they clamp the toolbar onto the image and
            it overlaps the top. Reserving vertical padding (> the ~40px toolbar
            above, > the toolbox below) keeps `offsetTop` large enough that both
            engines lay their chrome out in the gaps instead of over the image. */}
        <div
          ref={hostRef}
          className={cn(
            "relative flex items-center justify-center overflow-hidden bg-inset",
            "h-[64vh] min-h-[380px] w-full",
            // First-paint estimate; reserveChrome() replaces these with the
            // measured toolbar/toolbox heights as soon as the engine is up.
            "px-2 pt-12 pb-28",
          )}
        />
      </div>
    </div>,
    document.body,
  );
}
