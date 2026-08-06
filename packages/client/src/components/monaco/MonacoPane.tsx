/**
 * The heavy Monaco surface — lazy-loaded so `monaco-editor` lands in its own
 * chunk and never bloats the initial bundle. Renders a read-only single-file
 * editor or a side-by-side diff. All app-token theming lives in ./setup.
 *
 * When a `selection` (1-based line range) is supplied — e.g. from a clickable
 * code pointer in an assistant message — the target line(s) are revealed and
 * whole-line highlighted (`.cm-ptr-line` / `.cm-ptr-gutter` in index.css). The
 * highlight re-applies if the selection or content changes while mounted.
 */
import { useEffect, useMemo, useRef } from "react";
import { Editor, DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Spinner } from "../ui/Spinner.js";
import { DISPATCH_THEME } from "./setup.js";
import type { CodeSelection } from "./store.js";

export interface MonacoPaneProps {
  mode: "file" | "diff";
  language: string;
  /** Working-tree content (single view, or the diff's right/modified side). */
  value: string;
  /** Base-ref content (the diff's left/original side). */
  original?: string;
  /** Side-by-side vs inline diff. */
  splitDiff?: boolean;
  /** 1-based line range to reveal + highlight on open (from a code pointer). */
  selection?: CodeSelection;
  /** Editable single-file mode (ignored for diff). Enables typing + Save. */
  editable?: boolean;
  /** Fires with the current text on every edit (editable mode only). */
  onChange?: (value: string) => void;
  /** Ctrl/Cmd+S inside the editor (editable mode only). */
  onSave?: () => void;
}

const COMMON: editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  lineHeight: 19,
  fontFamily:
    '"JetBrains Mono", "Cascadia Code", ui-monospace, "SFMono-Regular", "Consolas", monospace',
  fontLigatures: false,
  smoothScrolling: true,
  cursorBlinking: "smooth",
  renderLineHighlight: "line",
  renderWhitespace: "none",
  guides: { indentation: false, highlightActiveIndentation: false },
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  padding: { top: 10, bottom: 10 },
  stickyScroll: { enabled: false },
  contextmenu: false,
};

/** Reveal + whole-line highlight a 1-based line range, clamped to the model. */
function applySelection(
  ed: editor.ICodeEditor | null,
  monaco: Monaco | null,
  deco: editor.IEditorDecorationsCollection | null,
  sel: CodeSelection | undefined,
): void {
  if (!ed || !monaco || !deco) return;
  const model = ed.getModel();
  if (!sel || !model) {
    deco.clear();
    return;
  }
  const max = model.getLineCount();
  const start = Math.max(1, Math.min(sel.startLine, max));
  const end = Math.max(start, Math.min(sel.endLine, max));
  const range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
  deco.set([
    {
      range,
      options: {
        isWholeLine: true,
        className: "cm-ptr-line",
        linesDecorationsClassName: "cm-ptr-gutter",
      },
    },
  ]);
  ed.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate);
  ed.setPosition({ lineNumber: start, column: 1 });
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center bg-inset">
      <Spinner size={18} />
    </div>
  );
}

export default function MonacoPane({
  mode,
  language,
  value,
  original = "",
  splitDiff = true,
  selection,
  editable = false,
  onChange,
  onSave,
}: MonacoPaneProps) {
  const fileOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      ...COMMON,
      lineNumbersMinChars: 3,
      readOnly: !editable,
      domReadOnly: !editable,
      // The editable config editor wants the usual editing affordances back.
      contextmenu: editable,
      quickSuggestions: editable,
    }),
    [editable],
  );
  const diffOptions = useMemo<editor.IDiffEditorConstructionOptions>(
    () => ({
      ...COMMON,
      renderSideBySide: splitDiff,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      // Right-side diff overview ruler: a self-contained 30px strip that maps
      // green(added)/red(removed) change zones onto the vertical scroll extent
      // (colours themed in ./setup) so you can see where edits land in the file.
      renderOverviewRuler: true,
      diffWordWrap: "off",
      renderIndicators: true,
    }),
    [splitDiff],
  );

  // The editor the pointer highlight lives on (the modified side for a diff).
  const edRef = useRef<editor.ICodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decoRef = useRef<editor.IEditorDecorationsCollection | null>(null);

  // Keep the latest onSave without re-binding the editor command on every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const bind = (ed: editor.ICodeEditor, monaco: Monaco) => {
    monaco.editor.setTheme(DISPATCH_THEME); // belt-and-suspenders if react re-inits
    edRef.current = ed;
    monacoRef.current = monaco;
    decoRef.current = ed.createDecorationsCollection();
    applySelection(ed, monaco, decoRef.current, selection);
  };

  // Re-reveal when the pointer target or the loaded content changes.
  useEffect(() => {
    applySelection(edRef.current, monacoRef.current, decoRef.current, selection);
  }, [selection?.startLine, selection?.endLine, value, mode, splitDiff]);

  if (mode === "diff") {
    return (
      <DiffEditor
        className="h-full"
        theme={DISPATCH_THEME}
        original={original}
        modified={value}
        language={language}
        options={diffOptions}
        loading={<Loading />}
        onMount={(diffEditor, monaco) => bind(diffEditor.getModifiedEditor(), monaco)}
      />
    );
  }

  return (
    <Editor
      className="h-full"
      theme={DISPATCH_THEME}
      value={value}
      language={language}
      options={fileOptions}
      loading={<Loading />}
      onMount={(ed, monaco) => {
        bind(ed, monaco);
        if (editable) {
          // Ctrl/Cmd+S saves without leaving the editor (standalone editor only).
          ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
            onSaveRef.current?.(),
          );
        }
      }}
      onChange={editable ? (v) => onChange?.(v ?? "") : undefined}
    />
  );
}
