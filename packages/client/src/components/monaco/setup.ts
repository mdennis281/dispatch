/**
 * Monaco bootstrap — runs ONCE, inside the lazy chunk (imported only by
 * MonacoPane). Bundles Monaco locally (no CDN fetch → works offline, which the
 * default `@monaco-editor/loader` does not), wires only the core editor worker
 * (enough for tokenizing + diff; no language diagnostics for a read-only view),
 * and registers the app-token dark theme.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Only the base editor worker — read-only preview needs no TS/JSON/CSS services.
(globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/** Registered theme name — matches the Linear/Zed tokens in index.css. */
export const DISPATCH_THEME = "dispatch-dark";

monaco.editor.defineTheme(DISPATCH_THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5b6472", fontStyle: "italic" },
    { token: "keyword", foreground: "9aa5ff" },
    { token: "keyword.control", foreground: "9aa5ff" },
    { token: "storage", foreground: "9aa5ff" },
    { token: "string", foreground: "8fc98f" },
    { token: "number", foreground: "d6a44b" },
    { token: "constant", foreground: "d6a44b" },
    { token: "type", foreground: "cbd0d6" },
    { token: "type.identifier", foreground: "cbd0d6" },
    { token: "function", foreground: "bcb0ff" },
    { token: "variable", foreground: "cbd0d6" },
    { token: "delimiter", foreground: "6b7280" },
    { token: "tag", foreground: "9aa5ff" },
    { token: "attribute.name", foreground: "bcb0ff" },
    { token: "attribute.value", foreground: "8fc98f" },
  ],
  colors: {
    "editor.background": "#0a0c0f",
    "editor.foreground": "#e6e8eb",
    "editorLineNumber.foreground": "#39414d",
    "editorLineNumber.activeForeground": "#9aa1a9",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#7c8aff33",
    "editor.inactiveSelectionBackground": "#7c8aff1a",
    "editor.selectionHighlightBackground": "#7c8aff1f",
    "editor.findMatchBackground": "#d6a44b55",
    "editor.findMatchHighlightBackground": "#d6a44b2e",
    "editorCursor.foreground": "#9aa5ff",
    "editorIndentGuide.background1": "#ffffff0d",
    "editorIndentGuide.activeBackground1": "#ffffff1f",
    "editorWhitespace.foreground": "#ffffff10",
    "editorGutter.background": "#0a0c0f",
    "editorWidget.background": "#111418",
    "editorWidget.border": "#ffffff14",
    "editorHoverWidget.background": "#14181d",
    "editorHoverWidget.border": "#ffffff14",
    "editorBracketMatch.background": "#7c8aff1f",
    "editorBracketMatch.border": "#7c8aff40",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff24",
    "scrollbarSlider.activeBackground": "#ffffff30",
    "editorOverviewRuler.border": "#00000000",
    // Right-side diff overview ruler markers (renderOverviewRuler) — muted
    // green/red change bars mapped to scroll position, matching the palette.
    "diffEditorOverview.insertedForeground": "#3fb950b0",
    "diffEditorOverview.removedForeground": "#ec5f6ab0",
    "diffEditor.insertedTextBackground": "#3fb95024",
    "diffEditor.removedTextBackground": "#ec5f6a26",
    "diffEditor.insertedLineBackground": "#3fb95014",
    "diffEditor.removedLineBackground": "#ec5f6a14",
    "diffEditorGutter.insertedLineBackground": "#3fb95026",
    "diffEditorGutter.removedLineBackground": "#ec5f6a26",
    "diffEditor.diagonalFill": "#ffffff0d",
  },
});

// Hand our bundled + themed instance to @monaco-editor/react (skips the CDN).
loader.config({ monaco });
