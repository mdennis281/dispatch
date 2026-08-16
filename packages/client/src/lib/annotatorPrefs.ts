/**
 * What the markup editor remembers between openings.
 *
 * The old editor remembered nothing. Its colour and stroke width lived on a
 * marker.js `MarkerArea` instance that was constructed inside a React effect and
 * torn down by that effect's cleanup, so the settings reset when you cropped,
 * when the crop returned, and every time the dialog reopened. Picking red at
 * width 5 was a per-session ritual.
 *
 * Settings are stored PER TOOL, not globally. One shared colour means reaching
 * for the highlighter (which wants yellow) silently repaints the pen (which
 * wants red), and you discover it on the next stroke. Per-tool state is what
 * makes the palette feel like it stayed where you left it.
 *
 * Global rather than per chat, in localStorage: it describes how you mark up,
 * not what this one conversation is about. Every storage access is guarded —
 * localStorage throws when cookies are blocked and is absent under vitest's node
 * environment.
 */
import { create } from "zustand";
import type { ShapeKind } from "../components/chat/annotator/doc.js";

/**
 * Fixed, deliberately NOT theme tokens. A marker has to stay legible against
 * whatever pixels are underneath it, which has nothing to do with whether the
 * app chrome is light or dark — a themed annotation colour would turn invisible
 * the moment someone screenshots a light page in dark mode.
 */
export const MARKUP_COLORS = [
  "#ff3b30",
  "#ff9500",
  "#ffd60a",
  "#34c759",
  "#0a84ff",
  "#bf5af2",
  "#ffffff",
  "#000000",
] as const;

export const STROKE_WIDTHS = [2, 4, 8, 16] as const;
export const FONT_SIZES = [16, 24, 36, 56] as const;

export interface ToolStyle {
  color: string;
  width: number;
}

/** Defaults chosen per tool: a highlighter starts yellow, a pen starts red. */
const DEFAULTS: Record<ShapeKind, ToolStyle> = {
  pen: { color: "#ff3b30", width: 4 },
  highlight: { color: "#ffd60a", width: 16 },
  arrow: { color: "#ff3b30", width: 4 },
  rect: { color: "#ff3b30", width: 4 },
  ellipse: { color: "#ff3b30", width: 4 },
  text: { color: "#ff3b30", width: 24 }, // `width` carries font size for text
  redact: { color: "#000000", width: 4 },
};

const KEY = "cm:annotator-style";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

/**
 * Tolerant load: anything unrecognised falls back to that tool's default rather
 * than failing the whole read, so a future tool added to the list starts sane
 * for people who already have a saved blob.
 */
function load(): Record<ShapeKind, ToolStyle> {
  const out = { ...DEFAULTS };
  try {
    const raw = backing()?.getItem(KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Record<string, Partial<ToolStyle>>;
    for (const kind of Object.keys(DEFAULTS) as ShapeKind[]) {
      const v = parsed[kind];
      if (!v) continue;
      out[kind] = {
        color: typeof v.color === "string" ? v.color : DEFAULTS[kind].color,
        width: typeof v.width === "number" && v.width > 0 ? v.width : DEFAULTS[kind].width,
      };
    }
  } catch {
    /* corrupt blob — defaults are a better outcome than a dead editor */
  }
  return out;
}

function persist(styles: Record<ShapeKind, ToolStyle>): void {
  try {
    backing()?.setItem(KEY, JSON.stringify(styles));
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

interface AnnotatorPrefs {
  styles: Record<ShapeKind, ToolStyle>;
  setStyle: (kind: ShapeKind, patch: Partial<ToolStyle>) => void;
}

export const useAnnotatorPrefs = create<AnnotatorPrefs>((set) => ({
  styles: load(),
  setStyle: (kind, patch) =>
    set((s) => {
      const styles = { ...s.styles, [kind]: { ...s.styles[kind], ...patch } };
      persist(styles);
      return { styles };
    }),
}));
