/**
 * The Git view's right-hand pane: a side-by-side (or inline) Monaco diff of one
 * path between two snapshots.
 *
 * Both sides are just revs, which is what lets ONE pane serve every case in the
 * view — staged (HEAD↔INDEX), unstaged (INDEX↔WORKTREE), a commit (`sha^`↔`sha`)
 * and a stash. The `EMPTY` sentinel stands in for "no such side" (an untracked
 * file has no index blob) so an addition renders as an all-green diff instead
 * of a failed fetch.
 *
 * Monaco is lazy — the loading/empty/binary/error states never pull the editor
 * bundle at all.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Columns2,
  Copy,
  Check,
  FileCode2,
  FileWarning,
  Rows2,
} from "lucide-react";
import { GIT_REV_EMPTY } from "@dispatch/shared";
import { api, type WorktreeFileContent } from "../../lib/api.js";
import { languageForPath } from "../monaco/lang.js";
import { Spinner } from "../ui/Spinner.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip } from "../ui/Chip.js";
import { midTruncate } from "../../lib/format.js";
import type { GitSelection } from "../../stores/git.js";
import { splitPath } from "./fileMeta.js";

const MonacoPane = lazy(() => import("../monaco/MonacoPane.js"));

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

export function GitDiffPane({
  repoPath,
  selection,
}: {
  repoPath: string;
  selection: GitSelection;
}) {
  const { relPath, leftRev, rightRev, label } = selection;
  const [splitDiff, setSplitDiff] = useState(true);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<WorktreeFileContent | null>(null);
  const [right, setRight] = useState<WorktreeFileContent | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setLeft(null);
    setRight(null);
    // The EMPTY sentinel never reaches the server — it IS the absence of a side.
    const fetchSide = (rev: string) =>
      rev === GIT_REV_EMPTY
        ? Promise.resolve({ ...EMPTY_FILE, path: relPath })
        : api.git
            .file(repoPath, relPath, rev)
            .catch(() => ({ ...EMPTY_FILE, path: relPath, ref: rev }));

    Promise.all([fetchSide(leftRev), fetchSide(rightRev)])
      .then(([l, r]) => {
        if (!live) return;
        setLeft(l);
        setRight(r);
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
  }, [repoPath, relPath, leftRev, rightRev]);

  const language = useMemo(() => languageForPath(relPath), [relPath]);
  const binary = !!left?.binary || !!right?.binary;
  const leftText = left?.encoding === "utf8" ? left.content : "";
  const rightText = right?.encoding === "utf8" ? right.content : "";
  const truncated = !!left?.truncated || !!right?.truncated;
  const { name, dir } = splitPath(relPath);

  const copyPath = () => {
    void navigator.clipboard?.writeText(relPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-inset">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <FileCode2 className="size-4 shrink-0 text-accent-hi" />
        <span className="min-w-0 truncate" title={relPath}>
          <span className="cm-mono !text-sm text-primary">{name}</span>
          {dir && (
            <span className="ml-1.5 cm-mono !text-2xs text-faint">
              {midTruncate(dir, 46)}
            </span>
          )}
        </span>
        <IconButton size="sm" tip={copied ? "Copied" : "Copy path"} onClick={copyPath}>
          {copied ? <Check className="text-success" /> : <Copy />}
        </IconButton>
        <div className="ml-auto flex items-center gap-2">
          <Chip tone="muted" mono>
            {label}
          </Chip>
          <IconButton
            size="sm"
            tip={splitDiff ? "Inline diff" : "Side-by-side diff"}
            active
            onClick={() => setSplitDiff((v) => !v)}
          >
            {splitDiff ? <Rows2 /> : <Columns2 />}
          </IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading ? (
          <Centered>
            <Spinner size={18} />
          </Centered>
        ) : error ? (
          <Note
            icon={<AlertTriangle className="text-danger" />}
            title="Couldn't open this file"
            detail={error}
          />
        ) : binary ? (
          <Note
            icon={<FileWarning className="text-warn" />}
            title="Binary file"
            detail={`${fmtBytes(right?.size || left?.size || 0)} — not shown as text.`}
          />
        ) : (
          <Suspense
            fallback={
              <Centered>
                <Spinner size={18} />
              </Centered>
            }
          >
            <MonacoPane
              mode="diff"
              language={language}
              value={rightText}
              original={leftText}
              splitDiff={splitDiff}
            />
          </Suspense>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-2xs text-faint">
        <span className="uppercase tracking-[0.08em]">{language}</span>
        <span className="cm-mono !text-2xs text-muted">
          {leftRev === GIT_REV_EMPTY ? "∅" : leftRev} → {rightRev}
        </span>
        {truncated && (
          <span className="ml-auto inline-flex items-center gap-1 text-warn">
            <AlertTriangle className="size-3" />
            Truncated at 2&nbsp;MB
          </span>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center">{children}</div>;
}

function Note({
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
