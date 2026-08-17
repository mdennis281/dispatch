/**
 * Monaco bootstrap — runs ONCE, inside the lazy chunk (imported only by
 * MonacoPane). Bundles Monaco locally (no CDN fetch → works offline, which the
 * default `@monaco-editor/loader` does not), wires only the core editor worker
 * (enough for tokenizing + diff; no language diagnostics for a read-only view),
 * and registers the app-token theme.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useTheme } from "../../stores/theme.js";
import { normalizeHex, withAlphaHex } from "./hex.js";

// Only the base editor worker — read-only preview needs no TS/JSON/CSS services.
(globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/** Registered theme name — the palette it carries is whatever was active when
 *  `defineTheme` last ran, so the name never has to change. */
export const DISPATCH_THEME = "dispatch";

/**
 * Monaco is the one surface that cannot consume the design tokens directly: its
 * theme API takes literal hex strings, resolved once into an internal colour
 * map, with no `var()` support anywhere. So we READ the tokens off the document
 * and hand Monaco the resolved values — and re-read them on every theme change,
 * or the editor would be the single pane still painting the old palette.
 */
function token(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  // Normalised, never raw: a production build ships `#fff` where the source
  // said `#ffffff`, and Monaco's parser rejects anything it can't read as one
  // of its four hex forms — answering with OPAQUE RED, not an error. See
  // ./hex. A missing token would instead hand Monaco "" and make it fall back
  // to vs-dark's own colour for that slot, which is the confusing failure:
  // mostly-right chrome with one wrong element. Magenta is impossible to miss.
  return normalizeHex(v);
}

/** Monaco's colour map wants #rrggbbaa; `alpha` is the two hex digits. */
function withAlpha(name: string, alpha: string): string {
  return withAlphaHex(token(name), alpha);
}

/** Monaco's TOKEN rules (as opposed to its colour map) want bare hex, no `#`. */
function bare(name: string): string {
  return token(name).replace("#", "");
}

function defineTheme(): void {
  const dark = document.documentElement.dataset.theme !== "light";
  monaco.editor.defineTheme(DISPATCH_THEME, {
    // `inherit` fills the hundreds of slots we don't name, so the base has to
    // match the palette's polarity or unnamed chrome (widgets, menus, sashes)
    // comes back inverted.
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: bare("--p-syn-comment"), fontStyle: "italic" },
      { token: "keyword", foreground: bare("--p-syn-keyword") },
      { token: "keyword.control", foreground: bare("--p-syn-keyword") },
      { token: "storage", foreground: bare("--p-syn-keyword") },
      { token: "string", foreground: bare("--p-syn-string") },
      { token: "number", foreground: bare("--p-syn-number") },
      { token: "constant", foreground: bare("--p-syn-const") },
      { token: "type", foreground: bare("--p-syn-text") },
      { token: "type.identifier", foreground: bare("--p-syn-text") },
      { token: "function", foreground: bare("--p-syn-fn") },
      { token: "variable", foreground: bare("--p-syn-text") },
      { token: "delimiter", foreground: bare("--p-syn-punct") },
      { token: "tag", foreground: bare("--p-syn-tag") },
      { token: "attribute.name", foreground: bare("--p-syn-prop") },
      { token: "attribute.value", foreground: bare("--p-syn-string") },
    ],
    colors: {
      "editor.background": token("--p-inset"),
      "editor.foreground": token("--p-text-primary"),
      "editorLineNumber.foreground": token("--p-text-faint"),
      "editorLineNumber.activeForeground": token("--p-text-secondary"),
      // The wash tokens are alpha-composited onto the editor background, so
      // they're built from `--p-wash` (the solid neutral each theme mixes its
      // hairlines from) rather than a fixed white that vanishes on light.
      "editor.lineHighlightBackground": withAlpha("--p-wash", "08"),
      // Fully transparent, i.e. "draw nothing" — Monaco has no way to UNSET an
      // inherited slot, so a zero-alpha colour is how you switch one off.
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": withAlpha("--p-accent-2", "33"),
      "editor.inactiveSelectionBackground": withAlpha("--p-accent-2", "1a"),
      "editor.selectionHighlightBackground": withAlpha("--p-accent-2", "1f"),
      "editor.findMatchBackground": withAlpha("--p-accent", "55"),
      "editor.findMatchHighlightBackground": withAlpha("--p-accent", "2e"),
      "editorCursor.foreground": token("--p-accent"),
      "editorIndentGuide.background1": withAlpha("--p-wash", "0d"),
      "editorIndentGuide.activeBackground1": withAlpha("--p-wash", "1f"),
      "editorWhitespace.foreground": withAlpha("--p-wash", "10"),
      "editorGutter.background": token("--p-inset"),
      "editorWidget.background": token("--p-panel"),
      "editorWidget.border": withAlpha("--p-wash", "14"),
      "editorHoverWidget.background": token("--p-panel-2"),
      "editorHoverWidget.border": withAlpha("--p-wash", "14"),
      "editorBracketMatch.background": withAlpha("--p-accent-2", "1f"),
      "editorBracketMatch.border": withAlpha("--p-accent-2", "40"),
      "scrollbarSlider.background": withAlpha("--p-wash", "14"),
      "scrollbarSlider.hoverBackground": withAlpha("--p-wash", "24"),
      "scrollbarSlider.activeBackground": withAlpha("--p-wash", "30"),
      "editorOverviewRuler.border": "#00000000",
      // Right-side diff overview ruler markers (renderOverviewRuler) — muted
      // green/red change bars mapped to scroll position, matching the palette.
      "diffEditorOverview.insertedForeground": withAlpha("--p-diff-add", "b0"),
      "diffEditorOverview.removedForeground": withAlpha("--p-diff-remove", "b0"),
      "diffEditor.insertedTextBackground": withAlpha("--p-diff-add", "24"),
      "diffEditor.removedTextBackground": withAlpha("--p-diff-remove", "26"),
      "diffEditor.insertedLineBackground": withAlpha("--p-diff-add", "14"),
      "diffEditor.removedLineBackground": withAlpha("--p-diff-remove", "14"),
      "diffEditorGutter.insertedLineBackground": withAlpha("--p-diff-add", "26"),
      "diffEditorGutter.removedLineBackground": withAlpha("--p-diff-remove", "26"),
      "diffEditor.diagonalFill": withAlpha("--p-wash", "0d"),
    },
  });
}

defineTheme();

// Re-registering under the SAME name is what repaints live editors: Monaco
// re-applies the active theme on redefinition, so no editor has to remount.
// Subscribing at module scope (not in a component) keeps it working for the
// diff pane, the file viewer and any future Monaco surface alike.
useTheme.subscribe(defineTheme);

// Hand our bundled + themed instance to @monaco-editor/react (skips the CDN).
loader.config({ monaco });
