/**
 * The code-preview overlay: a Linear/Zed dark modal that reads a worktree file
 * (working tree + base ref) and shows it as a read-only single file OR a
 * side-by-side diff vs `base`. The heavy editor (`MonacoPane`) is lazy so
 * `monaco-editor` never touches the initial bundle. Fetch/loading/empty/error
 * states render without pulling Monaco at all.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FileCode2,
  X,
  Copy,
  Check,
  Columns2,
  Rows2,
  GitBranch,
  AlertTriangle,
  FileWarning,
  FileX2,
  Save,
} from "lucide-react";
import {
  readWorktreeFile,
  writeWorktreeFile,
  type WorktreeFileContent,
} from "../../lib/actions.js";
import { useCodeViewer, type CodeViewerMode, type CodeViewerRequest } from "./store.js";
import { languageForPath, isImagePath, imageMimeForPath } from "./lang.js";
import { Spinner } from "../ui/Spinner.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl, type Segment } from "../ui/SegmentedControl.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";

const MonacoPane = lazy(() => import("./MonacoPane.js"));

const EMPTY_FILE: WorktreeFileContent = {
  path: "",
  content: "",
  encoding: "utf8",
  binary: false,
  size: 0,
  exists: false,
  truncated: false,
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

export function CodeViewer({ request }: { request: CodeViewerRequest }) {
  const close = useCodeViewer((s) => s.close);
  const { worktreePath, relPath, base, branch } = request;
  const editable = !!request.editable;

  const [mode, setMode] = useState<CodeViewerMode>(request.mode);
  const [splitDiff, setSplitDiff] = useState(true);
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<WorktreeFileContent | null>(null);
  const [original, setOriginal] = useState<WorktreeFileContent | null>(null);

  // Editable-mode state: the live draft, the last-persisted baseline (for the
  // dirty check), and save status.
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const dirty = editable && draft !== baseline;

  // Reset view mode whenever a new file is requested.
  useEffect(() => setMode(request.mode), [request.mode, worktreePath, relPath]);

  // Fetch working-tree + base content (base is tolerant: a new file has none).
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setWorking(null);
    setOriginal(null);
    Promise.all([
      readWorktreeFile(worktreePath, relPath),
      readWorktreeFile(worktreePath, relPath, base).catch(() => ({
        ...EMPTY_FILE,
        path: relPath,
        ref: base,
      })),
    ])
      .then(([w, o]) => {
        if (!live) return;
        setWorking(w);
        setOriginal(o);
        const seed = w.encoding === "utf8" ? w.content : "";
        setDraft(seed);
        setBaseline(seed);
        setSaveErr(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "Failed to read file.");
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [worktreePath, relPath, base]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const language = useMemo(() => languageForPath(relPath), [relPath]);
  const isImage = isImagePath(relPath);
  const workingBinary = !!working?.binary;
  // No editable diff — the config editor is always a single-file edit.
  const canDiff = !workingBinary && !error && !editable;
  const effectiveMode: CodeViewerMode = canDiff ? mode : "file";

  const modifiedText = working?.encoding === "utf8" ? working.content : "";
  const originalText = original?.encoding === "utf8" ? original.content : "";
  const truncated = !!working?.truncated || (effectiveMode === "diff" && !!original?.truncated);

  const copyPath = () => {
    void navigator.clipboard?.writeText(relPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const save = async () => {
    if (!editable || saving || !dirty) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await writeWorktreeFile(worktreePath, relPath, draft);
      setBaseline(draft);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1400);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Failed to save file.");
    } finally {
      setSaving(false);
    }
  };

  const segments = useMemo<Segment<CodeViewerMode>[]>(
    () =>
      canDiff
        ? [
            { value: "file", label: "File" },
            { value: "diff", label: "Diff" },
          ]
        : [{ value: "file", label: "File" }],
    [canDiff],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      {/* backdrop */}
      <button
        aria-label="Close preview"
        onClick={close}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px] cm-anim-rise"
      />

      <div className="relative flex h-[86vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-[var(--shadow-pop)] cm-anim-rise">
        {/* header */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <FileCode2 className="size-4 shrink-0 text-accent-hi" />
          <span
            className="min-w-0 truncate cm-mono !text-[12px] text-primary"
            title={`${worktreePath}/${relPath}`}
          >
            {midTruncate(relPath, 60)}
          </span>
          <IconButton size="sm" tip={copied ? "Copied" : "Copy path"} onClick={copyPath}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconButton>

          <div className="ml-auto flex items-center gap-2">
            {editable && (
              <Button
                size="xs"
                variant={dirty ? "primary" : "subtle"}
                leftIcon={
                  saving ? <Spinner size={12} /> : savedTick ? <Check /> : <Save />
                }
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : dirty ? "Save" : "Saved"}
              </Button>
            )}
            {branch && (
              <Chip tone="muted" mono>
                <GitBranch className="mr-1 inline size-3" />
                {branch}
              </Chip>
            )}
            {segments.length > 1 && (
              <SegmentedControl
                segments={segments}
                value={effectiveMode}
                onChange={(v) => setMode(v)}
              />
            )}
            {effectiveMode === "diff" && (
              <IconButton
                size="sm"
                tip={splitDiff ? "Inline diff" : "Side-by-side diff"}
                active
                onClick={() => setSplitDiff((v) => !v)}
              >
                {splitDiff ? <Rows2 /> : <Columns2 />}
              </IconButton>
            )}
            <span className="mx-0.5 h-4 w-px bg-line" />
            <IconButton size="md" tip="Close (Esc)" onClick={close}>
              <X />
            </IconButton>
          </div>
        </div>

        {/* body */}
        <div className="relative min-h-0 flex-1 bg-inset">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={18} />
            </div>
          ) : error ? (
            <StateNote
              icon={<AlertTriangle className="text-danger" />}
              title="Couldn't open this file"
              detail={error}
            />
          ) : isImage && workingBinary && working ? (
            <ImagePreview file={working} relPath={relPath} />
          ) : workingBinary ? (
            <StateNote
              icon={<FileWarning className="text-warn" />}
              title="Binary file"
              detail={`${fmtBytes(working?.size ?? 0)} — not shown as text.`}
            />
          ) : !editable && !working?.exists && !modifiedText && (effectiveMode !== "diff" || !originalText) ? (
            // …but in diff mode with content at base, this is a DELETION — fall
            // through to Monaco so the removal renders instead of "missing file".
            // (Editable mode always opens the editor — a new file starts empty.)
            <StateNote
              icon={<FileX2 className="text-muted" />}
              title="Empty or missing file"
              detail={`${relPath} has no readable content in this worktree.`}
            />
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner size={18} />
                </div>
              }
            >
              <MonacoPane
                mode={effectiveMode}
                language={language}
                value={editable ? draft : modifiedText}
                original={originalText}
                splitDiff={splitDiff}
                selection={request.selection}
                editable={editable}
                onChange={setDraft}
                onSave={save}
              />
            </Suspense>
          )}
        </div>

        {/* footer */}
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line px-3 text-[10.5px] text-faint">
          <span className="uppercase tracking-[0.08em]">{language}</span>
          {working && !workingBinary && (
            <span className="tabular-nums">{fmtBytes(working.size)}</span>
          )}
          {effectiveMode === "diff" && (
            <span className="text-muted">
              vs <span className="cm-mono !text-[10px] text-secondary">{base}</span>
            </span>
          )}
          {editable && (
            <span className={cn("cm-mono !text-[10px]", dirty ? "text-warn" : "text-faint")}>
              {dirty ? "unsaved changes" : "saved"}
            </span>
          )}
          {saveErr && (
            <span className="inline-flex items-center gap-1 text-danger" title={saveErr}>
              <AlertTriangle className="size-3" />
              {midTruncate(saveErr, 48)}
            </span>
          )}
          {truncated && (
            <span className="ml-auto inline-flex items-center gap-1 text-warn">
              <AlertTriangle className="size-3" />
              Truncated at 2&nbsp;MB
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StateNote({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="mb-2 flex size-9 items-center justify-center rounded-md border border-line bg-panel-2 [&_svg]:size-4">
        {icon}
      </span>
      <p className="text-[12.5px] font-medium text-secondary">{title}</p>
      {detail && (
        <p className="mt-0.5 max-w-md cm-mono !text-[11px] text-faint break-words">{detail}</p>
      )}
    </div>
  );
}

/** Inline preview of an image file straight out of the worktree (base64). */
function ImagePreview({ file, relPath }: { file: WorktreeFileContent; relPath: string }) {
  const src =
    file.encoding === "base64"
      ? `data:${imageMimeForPath(relPath)};base64,${file.content}`
      : `data:${imageMimeForPath(relPath)};utf8,${encodeURIComponent(file.content)}`;
  return (
    <div
      className="flex h-full items-center justify-center overflow-auto p-6"
      style={{
        backgroundImage:
          "linear-gradient(45deg,#14181d 25%,transparent 25%),linear-gradient(-45deg,#14181d 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#14181d 75%),linear-gradient(-45deg,transparent 75%,#14181d 75%)",
        backgroundSize: "18px 18px",
        backgroundPosition: "0 0,0 9px,9px -9px,-9px 0",
      }}
    >
      <img
        src={src}
        alt={baseName(relPath)}
        className="max-h-full max-w-full rounded-sm border border-line-strong bg-inset shadow-[var(--shadow-pop)]"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}
