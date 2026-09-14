import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, FileText, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { ClaudeMemoryFile, ClaudeMemoryListing } from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { Markdown } from "../chat/Markdown.js";
import { cn } from "../../lib/cn.js";
import { MemoryListRow } from "./MemoryListRow.js";

const TYPE_TONE: Record<string, Tone> = {
  user: "accent",
  feedback: "warn",
  project: "success",
  reference: "muted",
};

/**
 * Claude Code's OWN auto-memory for this project's repo — the `MEMORY.md` it
 * loads into every Claude session, independent of Dispatch's project memory.
 * Edits are raw file edits (frontmatter included): Claude Code owns the format.
 */
export function ClaudeMemoryPanel({ projectId, header }: { projectId: string; header: ReactNode }) {
  const [listing, setListing] = useState<ClaudeMemoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setError(null);
    return api.claudeMemory
      .list(projectId)
      .then(setListing)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load."));
  }, [projectId]);

  useEffect(() => {
    setListing(null);
    setSelected(null);
    setQuery("");
    void load();
  }, [load]);

  const files = listing?.files ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) =>
      [f.name, f.description, f.body].some((t) => t.toLowerCase().includes(q)),
    );
  }, [files, query]);
  const current = files.find((f) => f.file === selected) ?? null;

  return (
    <div className="flex min-w-0 flex-1 bg-app">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-surface">
        {header}
        <div className="p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-inset px-2">
            <Search className="size-3.5 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Claude memory…"
              spellCheck={false}
              className="h-7 w-full bg-transparent text-sm text-primary outline-none placeholder:text-faint"
            />
            <IconButton size="sm" tip="Reload from disk" onClick={() => void load()}>
              <RefreshCw />
            </IconButton>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 px-2 pb-2">
            {error ? (
              <p className="px-2 py-6 text-center text-xs text-danger">{error}</p>
            ) : !listing ? (
              <p className="px-2 py-6 text-center text-xs text-faint">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-faint">
                {files.length === 0 ? "Claude Code hasn't recorded anything for this repo." : "No matches."}
              </p>
            ) : (
              shown.map((f) => (
                <MemoryListRow key={f.file} active={f.file === selected} onClick={() => setSelected(f.file)}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate cm-mono !text-xs font-medium text-primary">
                      {f.isIndex ? "MEMORY.md (index)" : f.name}
                    </span>
                    {f.type && <Chip tone={TYPE_TONE[f.type] ?? "muted"}>{f.type}</Chip>}
                  </div>
                  {f.description && (
                    <span className="truncate text-2xs text-faint">{f.description}</span>
                  )}
                </MemoryListRow>
              ))
            )}
          </div>
        </ScrollArea>
        {listing && (
          <p className="truncate px-3 py-2 cm-mono !text-2xs text-faint cm-hairline-t" title={listing.dir}>
            {listing.dir}
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <ClaudeMemoryDetail
            key={current.file}
            projectId={projectId}
            file={current}
            onSaved={(saved) =>
              setListing((l) =>
                l ? { ...l, files: l.files.map((f) => (f.file === saved.file ? saved : f)) } : l,
              )
            }
            onDeleted={() => {
              setSelected(null);
              // The server also rewrote MEMORY.md, so re-read rather than patch.
              void load();
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <FileText className="mb-2 size-6 text-faint" />
            <p className="text-base text-muted">Select a file to view it.</p>
            <p className="mt-0.5 max-w-sm text-xs text-faint">
              Claude Code's own memory for this repo. Its MEMORY.md index loads into every Claude
              chat alongside Dispatch's project memory.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ClaudeMemoryDetail({
  projectId,
  file,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  file: ClaudeMemoryFile;
  onSaved: (saved: ClaudeMemoryFile) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(file.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step delete: unlike project memory there's no git history behind these
  // files, so a stray click is unrecoverable.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.claudeMemory.update(projectId, file.file, content);
      onSaved(saved);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.claudeMemory.remove(projectId, file.file);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1 truncate cm-mono !text-base font-semibold text-primary">
          {file.isIndex ? "MEMORY.md" : file.name}
        </span>
        {file.type && <Chip tone={TYPE_TONE[file.type] ?? "muted"}>{file.type}</Chip>}
        {editing ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<X />}
              onClick={() => {
                setEditing(false);
                setContent(file.content);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" leftIcon={<Check />} disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="subtle" leftIcon={<Pencil />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {!file.isIndex &&
              (confirmDelete ? (
                <Button
                  size="sm"
                  variant="danger"
                  leftIcon={<Trash2 />}
                  disabled={busy}
                  onClick={() => void remove()}
                  onBlur={() => setConfirmDelete(false)}
                >
                  Confirm delete
                </Button>
              ) : (
                <IconButton
                  size="sm"
                  tip="Delete file (and its MEMORY.md line)"
                  className="hover:text-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 />
                </IconButton>
              ))}
          </>
        )}
      </div>
      {error && <p className="px-5 pt-3 text-xs text-danger">{error}</p>}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-4">
          {editing ? (
            <textarea
              autoFocus
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              spellCheck={false}
              className={
                "min-h-96 w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2 cm-mono " +
                "!text-xs leading-relaxed text-primary outline-none focus:border-line-strong"
              }
            />
          ) : (
            <>
              {file.description && <p className="mb-4 text-sm text-secondary">{file.description}</p>}
              {file.body ? (
                <Markdown>{file.body}</Markdown>
              ) : (
                <p className="text-sm italic text-faint">(empty)</p>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
