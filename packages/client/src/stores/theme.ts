/**
 * The active color theme, live in the client.
 *
 * Theme is the one preference that must be right BEFORE React exists. A palette
 * chosen after mount means a dark flash on a light theme (or the reverse) on
 * every single load, so the real applier is a four-line inline script in
 * `index.html` that runs against localStorage during head parsing. This store is
 * the runtime half of that same contract: same key, same attribute, same
 * resolution rules. **Change one, change both** — they are duplicated precisely
 * because nothing importable can run early enough.
 *
 * The server also persists a `theme` in app settings, and that stays the
 * cross-device source of truth (`SettingsPanel` pushes it in on load and save).
 * localStorage is a CACHE of it, not a rival: it exists only so the first paint
 * has an answer before `GET /api/settings` can possibly return.
 */
import { create } from "zustand";

/** `system` defers to the OS; the other two pin it regardless of the OS. */
export type ThemePref = "dark" | "light" | "system";

/** What actually gets written to the document — `system` is resolved away. */
export type ResolvedTheme = "dark" | "light";

/** Mirrored verbatim in the `index.html` pre-paint script. */
export const THEME_STORAGE_KEY = "dispatch:theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Default is dark: it is the palette the product is designed in, and an
 *  unreadable first paint is worse than ignoring an OS preference we have not
 *  been told to honor. */
export const DEFAULT_THEME: ThemePref = "dark";

function isPref(v: unknown): v is ThemePref {
  return v === "dark" || v === "light" || v === "system";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== "system") return pref;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * Repaint the window controls to match the header.
 *
 * Chromium draws the minimise/maximise/close buttons of an installed window on a
 * slab of `theme_color`, and picks light or dark glyphs from it. The manifest can
 * only state ONE colour, so a manifest value is wrong for one of the two themes
 * by construction — on light it left a dark slab in the top-right corner of an
 * otherwise pale header. `<meta name="theme-color">` is the live version of the
 * same setting: Chromium re-reads it, so following the palette here is what makes
 * the buttons sit in the header rather than on top of it.
 *
 * The colour is READ from `--p-surface` rather than restated: `bg-surface` is what
 * the top bar is painted with (see components/layout/TopBar), and a second copy of
 * that hex in TypeScript is a copy that goes stale the first time the palette is
 * touched — silently, because nothing renders it side by side with the real one
 * except the window frame.
 *
 * Also runs where there is no overlay at all: it colours the ordinary standalone
 * title bar, the Android task switcher and the install splash, all of which want
 * the same answer.
 */
export function syncThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--p-surface")
    .trim();
  // Empty means the palette stylesheet has not landed yet. The generated meta in
  // index.html already carries the dark default, so leaving it alone is right.
  if (surface) meta.setAttribute("content", surface);
}

/**
 * Write the theme to the document. `color-scheme` is set alongside the
 * attribute even though `index.css` also sets it per-theme: the inline
 * pre-paint script has no stylesheet yet, and without it the browser paints its
 * own dark canvas behind the page for the few ms before CSS lands.
 */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  syncThemeColor();
  return resolved;
}

function readStored(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isPref(raw) ? raw : DEFAULT_THEME;
  } catch {
    // Private mode / blocked storage — the theme is not worth failing boot over.
    return DEFAULT_THEME;
  }
}

interface ThemeStore {
  /** What the user asked for, including the unresolved `system`. */
  pref: ThemePref;
  /** What is actually painted right now. Components should read THIS. */
  resolved: ResolvedTheme;
  setTheme: (pref: ThemePref) => void;
}

export const useTheme = create<ThemeStore>((set) => {
  const pref = readStored();
  return {
    pref,
    // Do not re-apply on module load: the pre-paint script already did, and
    // repeating it here would be the one place the two could silently diverge
    // without anyone noticing.
    resolved: resolveTheme(pref),
    setTheme: (next) => {
      const resolved = applyTheme(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Non-fatal: the theme applies for this session, just not the next one.
      }
      set({ pref: next, resolved });
    },
  };
});

/**
 * Follow the OS while the preference is `system`.
 *
 * Registered once at startup rather than in a component effect, because the
 * palette is a document-level concern — it must keep tracking even when no
 * settings UI is mounted, which is ~always.
 */
export function watchSystemTheme(): void {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", () => {
    const { pref } = useTheme.getState();
    if (pref !== "system") return;
    useTheme.setState({ resolved: applyTheme(pref) });
  });
}
