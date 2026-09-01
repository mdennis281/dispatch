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
  readWorktreeImage,
  writeWorktreeFile,
  type WorktreeFileContent,
} from "../../lib/actions.js";
import { useCodeViewer, type CodeViewerMode, type CodeViewerRequest } from "./store.js";
import { languageForPath, isImagePath } from "./lang.js";
import { ImagePreview } from "./ImagePreview.js";
import { Spinner } from "../ui/Spinner.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl, type Segment } from "../ui/SegmentedControl.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";
import { midTruncate } from "../../lib/format.js";
import { ApiError } from "../../lib/api.js";
import { leaseImagePreview } from "./imagePreviewLease.js";

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

function fmtPreviewLimit(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) {
    return `${n / (1024 * 1024)} MB`;
  }
  return fmtBytes(n);
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

export function CodeViewer({ request }: { request: CodeViewerRequest }) {
  const close = useCodeViewer((s) => s.close);
  const { worktreePath, relPath, base, branch } = request;
  const editable = !!request.editable;
  const isImage = isImagePath(relPath);
  // Above whatever opened it — this viewer is routinely launched FROM the
  // project-config dialog, and a file you asked to see must not open behind it.
  const z = useDialogLayer();

  const [mode, setMode] = useState<CodeViewerMode>(request.mode);
  const [splitDiff, setSplitDiff] = useState(true);
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<WorktreeFileContent | null>(null);
  const [original, setOriginal] = useState<WorktreeFileContent | null>(null);
  const [image, setImage] = useState<{
    src: string;
    size: number;
    limit: number;
    truncated: boolean;
  } | null>(null);

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
    let imageLease: ReturnType<typeof leaseImagePreview> | null = null;
    setLoading(true);
    setError(null);
    setWorking(null);
    setOriginal(null);
    setImage(null);

    const abort = new AbortController();
    const loadText = async () => {
      const [w, o] = await Promise.all([
        readWorktreeFile(worktreePath, relPath),
        // `true` = read the base side at the fork point, not at `base`'s tip.
        // Otherwise a branch cut before `main` moved shows every commit that
        // landed since as its own deletion — hunks it never made, on files the
        // worktree panel's list (which is merge-base'd) doesn't even mention.
        readWorktreeFile(worktreePath, relPath, base, true).catch(() => ({
          ...EMPTY_FILE,
          path: relPath,
          ref: base,
        })),
      ]);
      if (!live) return;
      setWorking(w);
      setOriginal(o);
      const seed = w.encoding === "utf8" ? w.content : "";
      setDraft(seed);
      setBaseline(seed);
      setSaveErr(null);
      setLoading(false);
    };

    const load = async () => {
      if (isImage) {
        try {
          const result = await readWorktreeImage(
            worktreePath,
            relPath,
            abort.signal,
          );
          if (!live) return;
          imageLease = leaseImagePreview(result.blob);
          setImage({
            src: imageLease.src,
            size: result.size,
            limit: result.limit,
            truncated: result.truncated,
          });
          setLoading(false);
          return;
        } catch (e) {
          // SVG, Git-LFS pointers, empty image-named files, and files removed
          // since their tool card rendered all remain useful in Monaco. The raw
          // route rejects or cannot find them, so preserve the old text/missing
          // behavior through the regular 2 MiB reader.
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 415)) {
            throw e;
          }
        }
      }
      await loadText();
    };

    void load().catch((e: unknown) => {
      if (!live) return;
      setError(e instanceof Error ? e.message : "Failed to read file.");
      setLoading(false);
    });
    return () => {
      live = false;
      abort.abort();
      imageLease?.dispose();
    };
  }, [worktreePath, relPath, base, isImage]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const language = useMemo(() => languageForPath(relPath), [relPath]);
  const workingBinary = !!working?.binary;
  // No editable diff — the config editor is always a single-file edit.
  const canDiff = !image && !workingBinary && !error && !editable;
  const effectiveMode: CodeViewerMode = canDiff ? mode : "file";

  const modifiedText = working?.encoding === "utf8" ? working.content : "";
  const originalText = original?.encoding === "utf8" ? original.content : "";
  const truncated =
    !!image?.truncated ||
    !!working?.truncated ||
    (effectiveMode === "diff" && !!original?.truncated);

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
      style={{ zIndex: z }}
      className="fixed inset-0 flex items-center justify-center cm-safe-pad [--cm-gutter:1rem] sm:[--cm-gutter:1.5rem]"
      role="dialog"
      aria-modal="true"
    >
      {/* backdrop */}
      <button
        aria-label="Close preview"
        onClick={close}
        className="absolute inset-0 cursor-default bg-scrim backdrop-blur-[2px] cm-anim-rise"
      />

      {/* Height as `full` capped at 86vh, not a flat 86vh: `full` is 100% of the
          overlay's CONTENT box, so whatever the safe-area gutters take comes off
          the panel automatically. A flat `86vh` is measured against the large
          viewport instead and can't see the insets at all. The cap is what keeps
          the desktop card off the window edges, as before. */}
      <div className="relative flex h-full max-h-[86vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-[var(--shadow-pop)] cm-anim-rise">
        {/* header */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <FileCode2 className="size-4 shrink-0 text-accent-hi" />
          <span
            className="min-w-0 truncate cm-mono !text-sm text-primary"
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
                size="sm"
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
          ) : image ? (
            <ImagePreview src={image.src} alt={baseName(relPath)} />
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
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line px-3 text-2xs text-faint">
          <span className="uppercase tracking-[0.08em]">{language}</span>
          {(image || (working && !workingBinary)) && (
            <span className="tabular-nums">{fmtBytes(image?.size ?? working?.size ?? 0)}</span>
          )}
          {effectiveMode === "diff" && (
            <span className="text-muted">
              vs <span className="cm-mono !text-2xs text-secondary">{base}</span>
            </span>
          )}
          {editable && (
            <span className={cn("cm-mono !text-2xs", dirty ? "text-warn" : "text-faint")}>
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
              Truncated at {fmtPreviewLimit(image?.limit || 2 * 1024 * 1024)}
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
      <p className="text-base font-medium text-secondary">{title}</p>
      {detail && (
        <p className="mt-0.5 max-w-md cm-mono !text-xs text-faint break-words">{detail}</p>
      )}
    </div>
  );
}
