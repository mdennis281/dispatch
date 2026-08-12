import { useEffect, useMemo, useState } from "react";
import { Brain, Plus, Pencil, Trash2, Search, Sparkles, X } from "lucide-react";
import type { ProjectMemory } from "@dispatch/shared";
import { TaskLauncherDialog } from "../tasks/TaskLauncherDialog.js";
import { useMemory, useProjectMemories } from "../../stores/memory.js";
import { loadProjectMemory } from "../../stores/index.js";
import { useActiveProject } from "../../stores/projects.js";
import { api } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip } from "../ui/Chip.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { Markdown } from "../chat/Markdown.js";
import { cn } from "../../lib/cn.js";
import { MemoryForm, TYPE_META } from "./MemoryForm.js";

/* ------------------------------------------------------------------ relevance */

/** Lowercased word tokens (≥2 chars) — mirrors the server's memory scorer. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Weighted substring/token relevance: name > description > body, whole-token
 *  beats substring. Same shape as the server's scorer so the list ranks the way
 *  the agent's `recall` does. 0 = no match. */
function scoreMemory(m: ProjectMemory, tokens: string[], q: string): number {
  const name = m.name.toLowerCase();
  const desc = m.description.toLowerCase();
  const body = m.body.toLowerCase();
  const nameTokens = new Set(tokenize(m.name));
  const descTokens = new Set(tokenize(m.description));
  const bodyTokens = new Set(tokenize(m.body));
  let score = 0;
  for (const t of tokens) {
    if (nameTokens.has(t)) score += 10;
    else if (name.includes(t)) score += 5;
    if (descTokens.has(t)) score += 4;
    else if (desc.includes(t)) score += 2;
    if (bodyTokens.has(t)) score += 2;
    else if (body.includes(t)) score += 1;
  }
  if (q.length >= 3) {
    if (name.includes(q)) score += 8;
    if (desc.includes(q)) score += 4;
    if (body.includes(q)) score += 3;
  }
  return score;
}

/** "3d ago" / "just now" style stamp for a memory's last write. */
function relativeTime(ms?: number): string | null {
  if (typeof ms !== "number") return null;
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

/* --------------------------------------------------------------------- rows */

function MemoryRow({
  memory,
  active,
  onClick,
}: {
  memory: ProjectMemory;
  active: boolean;
  onClick: () => void;
}) {
  const meta = TYPE_META[memory.type];
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-line-strong bg-accent-ghost"
          : "border-transparent hover:border-line hover:bg-panel-2/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate cm-mono !text-xs font-medium text-primary">
          {memory.name}
        </span>
        <Chip tone={meta.tone}>{meta.label}</Chip>
      </div>
      {memory.description && (
        <span className="truncate text-2xs text-faint">{memory.description}</span>
      )}
    </button>
  );
}

/* --------------------------------------------------------------------- viewer */

function MemoryViewer({
  memory,
  onEdit,
  onDelete,
}: {
  memory: ProjectMemory;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = TYPE_META[memory.type];
  const stamp = relativeTime(memory.updatedAt);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1 truncate cm-mono !text-base font-semibold text-primary">
          {memory.name}
        </span>
        <Chip tone={meta.tone}>{meta.label}</Chip>
        <Button size="sm" variant="subtle" leftIcon={<Pencil />} onClick={onEdit}>
          Edit
        </Button>
        <IconButton size="sm" tip="Delete memory" className="hover:text-danger" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-4">
          {memory.description && (
            <p className="mb-1 text-sm text-secondary">{memory.description}</p>
          )}
          {stamp && <p className="mb-4 text-2xs text-faint">Updated {stamp}</p>}
          {memory.body ? (
            <Markdown>{memory.body}</Markdown>
          ) : (
            <p className="text-sm italic text-faint">(no body)</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ----------------------------------------------------------------------- view */

/** The top-level, chat-independent Memory browser: a searchable list (sidebar 2)
 *  on the left and a viewer/editor for the selected memory on the right. Scoped
 *  to the active project — reuses the existing project-memory store + REST. */
export function MemoryView() {
  const project = useActiveProject();
  const projectId = project?.id ?? null;
  const memories = useProjectMemories(projectId);
  const loaded = useMemory((s) => (projectId ? s.loaded[projectId] : false));

  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // null = viewing; "new" = create; a memory = edit.
  const [form, setForm] = useState<"new" | ProjectMemory | null>(null);
  const [consolidating, setConsolidating] = useState(false);

  useEffect(() => {
    if (projectId && !loaded) void loadProjectMemory(projectId);
  }, [projectId, loaded]);

  // Reset transient UI when the project changes.
  useEffect(() => {
    setQuery("");
    setSelectedName(null);
    setForm(null);
    setConsolidating(false);
  }, [projectId]);

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    const tokens = [...new Set(tokenize(q))];
    return memories
      .map((m) => ({ m, score: scoreMemory(m, tokens, q) }))
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.m.updatedAt ?? 0) - (a.m.updatedAt ?? 0) ||
          a.m.name.localeCompare(b.m.name),
      )
      .map((s) => s.m);
  }, [memories, query]);

  const selected = selectedName ? memories.find((m) => m.name === selectedName) ?? null : null;

  const remove = (memory: ProjectMemory) => {
    // Optimistic — the WS `memory-deleted` also removes it (idempotent).
    useMemory.getState().remove(memory.projectId, memory.name);
    if (selectedName === memory.name) setSelectedName(null);
    void api.memory.remove(memory.projectId, memory.name).catch(() => {
      /* a failed delete is restored on the next hydrate */
    });
  };

  if (!projectId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-center">
        <Brain className="mb-2 size-6 text-faint" />
        <p className="text-base font-medium text-secondary">No project selected</p>
        <p className="mt-0.5 text-xs text-muted">Pick a project to browse its memory.</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 bg-app">
      {/* sidebar 2 — searchable memory list */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-12 shrink-0 items-center gap-2 px-3 cm-hairline-b">
          <Brain className="size-4 text-muted" />
          <span className="flex-1 text-base font-semibold text-primary">Memory</span>
          <span className="cm-mono !text-2xs text-faint">{memories.length}</span>
          {/* Curation lives next to the count, because the count IS the reason
              you reach for it — a store worth consolidating announces itself.
              Hidden rather than disabled below two memories: a disabled
              IconButton has `pointer-events-none`, so its tooltip never fires
              and the affordance would be a mute grey square. */}
          {memories.length >= 2 && (
            <IconButton
              size="sm"
              tip="Consolidate memory — audit, merge duplicates, retire what's stale"
              onClick={() => setConsolidating(true)}
            >
              <Sparkles />
            </IconButton>
          )}
          <IconButton size="sm" tip="New memory" onClick={() => setForm("new")}>
            <Plus />
          </IconButton>
        </div>

        <div className="p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-inset px-2">
            <Search className="size-3.5 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory…"
              spellCheck={false}
              className="h-7 w-full bg-transparent text-sm text-primary outline-none placeholder:text-faint"
            />
            {query && (
              <IconButton size="sm" tip="Clear" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            )}
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 px-2 pb-2">
            {ranked.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-faint">
                {memories.length === 0 ? "No memory recorded yet." : "No matches."}
              </p>
            ) : (
              ranked.map((m) => (
                <MemoryRow
                  key={m.name}
                  memory={m}
                  active={m.name === selectedName}
                  onClick={() => {
                    setSelectedName(m.name);
                    setForm(null);
                  }}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* right — viewer / editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        {form ? (
          <ScrollArea className="min-h-0 flex-1">
            <MemoryForm
              projectId={projectId}
              initial={form === "new" ? null : form}
              onDone={(saved) => {
                setForm(null);
                if (saved) setSelectedName(saved.name);
              }}
            />
          </ScrollArea>
        ) : selected ? (
          <MemoryViewer
            memory={selected}
            onEdit={() => setForm(selected)}
            onDelete={() => remove(selected)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Brain className="mb-2 size-6 text-faint" />
            <p className="text-base text-muted">
              {memories.length === 0 ? "No project memory yet." : "Select a memory to view it."}
            </p>
            <p className="mt-0.5 text-xs text-faint">
              Durable facts agents record (or you add) live here, independent of any chat.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="subtle" leftIcon={<Plus />} onClick={() => setForm("new")}>
                New memory
              </Button>
              {memories.length >= 2 && (
                <Button
                  size="sm"
                  variant="subtle"
                  leftIcon={<Sparkles />}
                  onClick={() => setConsolidating(true)}
                >
                  Consolidate
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <TaskLauncherDialog
        taskId="memory:consolidate"
        projectId={projectId}
        open={consolidating}
        onClose={() => setConsolidating(false)}
      />
    </div>
  );
}
