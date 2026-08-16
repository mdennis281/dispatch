/**
 * The editor's controls.
 *
 * Deliberately bottom-anchored rather than floating over the picture. The old
 * editor let marker.js position its toolbar above the image and its swatches
 * below it, computed from the image's own box — so on a tall screenshot the
 * chrome landed ON the picture, and 30 lines of `reserveChrome` + a
 * ResizeObserver existed purely to shove it back off. Owning the layout means
 * the controls simply have their own row and the canvas has its own box.
 *
 * It also puts every control within thumb reach on a phone, which is where a
 * bottom bar belongs, and both rows scroll horizontally instead of wrapping so
 * the canvas never loses height as tools are added.
 */
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Circle,
  Crop,
  EyeOff,
  Highlighter,
  MousePointer2,
  Pen,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { FONT_SIZES, MARKUP_COLORS, STROKE_WIDTHS } from "../../../lib/annotatorPrefs.js";
import { cn } from "../../../lib/cn.js";
import { IconButton } from "../../ui/IconButton.js";
import type { ShapeKind } from "./doc.js";

export type ToolId = ShapeKind | "select";

const TOOLS: { id: ToolId; label: string; icon: ReactNode }[] = [
  { id: "select", label: "Select", icon: <MousePointer2 /> },
  { id: "pen", label: "Pen", icon: <Pen /> },
  { id: "highlight", label: "Highlighter", icon: <Highlighter /> },
  { id: "arrow", label: "Arrow", icon: <ArrowUpRight /> },
  { id: "rect", label: "Rectangle", icon: <Square /> },
  { id: "ellipse", label: "Ellipse", icon: <Circle /> },
  { id: "text", label: "Text", icon: <Type /> },
  { id: "redact", label: "Redact", icon: <EyeOff /> },
];

/**
 * Grows the TOUCH target to ~48px without growing the button, via a pseudo
 * element that is still part of the button itself and so still clickable. The
 * visible size stays the kit's 32px, so this row looks like every other toolbar
 * in the app; only a fingertip sees the difference, and only on a touchscreen.
 */
const TOUCH = "relative after:absolute after:-inset-2 after:content-[''] sm:after:hidden";

const ROW =
  "flex items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export interface ToolbarProps {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  /** Style of the tool whose settings are showing (the selection, or the tool). */
  styleKind: ShapeKind;
  color: string;
  width: number;
  onColor: (c: string) => void;
  onWidth: (w: number) => void;
  onCrop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
}

export function Toolbar(p: ToolbarProps) {
  // Text has no stroke width; the same control picks its size instead, so the
  // row never goes empty and never grows a second widget.
  const isText = p.styleKind === "text";
  const sizes: readonly number[] = isText ? FONT_SIZES : STROKE_WIDTHS;
  // Redact is an opaque block — a stroke width would do nothing visible.
  const showSizes = p.styleKind !== "redact";
  const sameColor = (c: string) => p.color.toLowerCase() === c.toLowerCase();

  return (
    <div className="cm-hairline-t bg-panel">
      <div className={cn(ROW, "py-2")}>
        {TOOLS.map((t) => (
          <IconButton
            key={t.id}
            size="md"
            tip={t.label}
            active={p.tool === t.id}
            aria-pressed={p.tool === t.id}
            onClick={() => p.onTool(t.id)}
            className={cn(TOUCH, "shrink-0")}
          >
            {t.icon}
          </IconButton>
        ))}

        <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />

        <IconButton size="md" tip="Crop & rotate" onClick={p.onCrop} className={cn(TOUCH, "shrink-0")}>
          <Crop />
        </IconButton>

        <span className="flex-1" />

        <IconButton
          size="md"
          tip="Undo"
          onClick={p.onUndo}
          disabled={!p.canUndo}
          className={cn(TOUCH, "shrink-0")}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          size="md"
          tip="Redo"
          onClick={p.onRedo}
          disabled={!p.canRedo}
          className={cn(TOUCH, "shrink-0")}
        >
          <Redo2 />
        </IconButton>
        <IconButton
          size="md"
          tip="Delete selected"
          onClick={p.onDelete}
          disabled={!p.canDelete}
          className={cn(TOUCH, "shrink-0 hover:bg-danger-ghost hover:text-danger")}
        >
          <Trash2 />
        </IconButton>
      </div>

      {/* style of the active tool (or of the current selection) */}
      <div className={cn(ROW, "pb-2")}>
        {MARKUP_COLORS.map((c) => (
          <IconButton
            key={c}
            size="md"
            tip={`Colour ${c}`}
            aria-pressed={sameColor(c)}
            onClick={() => p.onColor(c)}
            className={cn(TOUCH, "shrink-0 hover:bg-transparent")}
          >
            <span
              className={cn(
                "block size-4 rounded-full ring-1 ring-inset ring-black/25 transition-shadow",
                // Ring in the PANEL colour then the accent, so the marker reads
                // as a halo rather than as a second, darker swatch edge.
                sameColor(c) && "shadow-[0_0_0_2px_var(--p-panel),0_0_0_4px_var(--p-accent)]",
              )}
              style={{ background: c }}
            />
          </IconButton>
        ))}

        {showSizes && (
          <>
            <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />
            {sizes.map((w) => (
              <IconButton
                key={w}
                size="md"
                tip={isText ? `Text size ${w}` : `Stroke width ${w}`}
                active={p.width === w}
                aria-pressed={p.width === w}
                onClick={() => p.onWidth(w)}
                className={cn(TOUCH, "shrink-0")}
              >
                {isText ? (
                  // The glyph IS the preview — a row of identical labels tells
                  // you nothing about what you are picking.
                  <span
                    style={{ fontSize: Math.min(18, 9 + w / 5) }}
                    className="font-semibold leading-none"
                  >
                    A
                  </span>
                ) : (
                  <span
                    className="block rounded-full bg-current"
                    style={{ width: Math.min(18, 4 + w), height: Math.min(18, 4 + w) }}
                  />
                )}
              </IconButton>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
