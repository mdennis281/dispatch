import { useEffect, useState } from "react";
import {
  Brain,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  Check,
  X,
} from "lucide-react";
import type { Chat, ProjectMemory, MemoryType } from "@cm/shared";
import { useMemory, useProjectMemories } from "../../stores/memory.js";
import { loadProjectMemory } from "../../stores/index.js";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Select } from "../ui/Select.js";
import { cn } from "../../lib/cn.js";

/** Per-type chip styling + label (matches the recorded memory kinds). */
const TYPE_META: Record<MemoryType, { label: string; tone: Tone }> = {
  user: { label: "user", tone: "accent" },
  feedback: { label: "feedback", tone: "warn" },
  project: { label: "project", tone: "success" },
  reference: { label: "reference", tone: "muted" },
};

const TYPE_OPTIONS = (Object.keys(TYPE_META) as MemoryType[]).map((value) => ({
  value,
  label: TYPE_META[value].label,
}));

const inputCls =
  "h-7 w-full rounded-md border border-line bg-inset px-2 text-[12px] text-primary outline-none " +
  "placeholder:text-faint focus:border-line-strong";

/** Create/edit form. `initial` set → edit (name is the fixed identity). */
function MemoryForm({
  projectId,
  initial,
  onDone,
}: {
  projectId: string;
  initial: ProjectMemory | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [type, setType] = useState<MemoryType>(initial?.type ?? "project");
  const [body, setBody] = useState(initial?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editing = !!initial;
  const nameValid = /[a-z0-9]/i.test(name);
  const valid = nameValid && body.trim().length > 0;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = editing
        ? await api.memory.update(projectId, initial!.name, { description, type, body })
        : await api.memory.create(projectId, { name, description, type, body });
      // Upsert from the response immediately (the WS `memory-update` echoes it too;
      // upsert is idempotent so the double is harmless).
      useMemory.getState().upsert(saved);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save memory.");
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
          {editing ? "Edit memory" : "New memory"}
        </span>
        <IconButton size="sm" tip="Cancel" onClick={onDone}>
          <X />
        </IconButton>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Name</span>
        <input
          autoFocus={!editing}
          value={name}
          disabled={editing}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          placeholder="deploy-runbook"
          className={cn(inputCls, "cm-mono !text-[11.5px]", editing && "opacity-60")}
        />
        {editing && (
          <span className="text-[10px] text-faint">Name is the memory's identity and can't be changed.</span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Type</span>
        <Select options={TYPE_OPTIONS} value={type} onChange={setType} width={200} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line summary (shown in the index)"
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="The full fact, in markdown…"
          className={cn(
            inputCls,
            "h-auto min-h-32 resize-y py-1.5 cm-mono !text-[11.5px] leading-relaxed",
          )}
        />
      </label>

      {error && <p className="text-[11px] text-danger">{error}</p>}

      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="primary"
          leftIcon={<Check />}
          disabled={!valid || saving}
          onClick={() => void submit()}
        >
          {editing ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function MemoryCard({
  memory,
  onEdit,
}: {
  memory: ProjectMemory;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = TYPE_META[memory.type];

  const remove = async () => {
    // Optimistic — the WS `memory-deleted` also removes it (idempotent).
    useMemory.getState().remove(memory.projectId, memory.name);
    try {
      await api.memory.remove(memory.projectId, memory.name);
    } catch {
      /* if it fails the next hydrate restores it */
    }
  };

  return (
    <div className="rounded-md border border-line bg-panel-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-faint" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate cm-mono !text-[11.5px] font-medium text-primary">
              {memory.name}
            </span>
            {memory.description && (
              <span className="block truncate text-[10.5px] text-faint">{memory.description}</span>
            )}
          </span>
        </button>
        <Chip tone={meta.tone}>{meta.label}</Chip>
      </div>

      {open && (
        <div className="border-t border-line-soft px-3 py-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words cm-mono !text-[11px] leading-relaxed text-secondary">
            {memory.body || "(empty)"}
          </pre>
        </div>
      )}

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
        <Button size="xs" variant="subtle" leftIcon={<Pencil />} onClick={onEdit}>
          Edit
        </Button>
        <IconButton
          size="sm"
          tip="Delete memory"
          className="ml-auto hover:text-danger"
          onClick={() => void remove()}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}

export function MemoryPanel({ chat }: { chat: Chat }) {
  const projectId = chat.projectId;
  const memories = useProjectMemories(projectId);
  const loaded = useMemory((s) => s.loaded[projectId]);
  // null = list; "new" = create form; a memory = edit form.
  const [form, setForm] = useState<"new" | ProjectMemory | null>(null);

  useEffect(() => {
    if (!loaded) void loadProjectMemory(projectId);
  }, [projectId, loaded]);

  // Reset any open form when the chat's project changes.
  useEffect(() => {
    setForm(null);
  }, [projectId]);

  if (form) {
    return (
      <MemoryForm
        projectId={projectId}
        initial={form === "new" ? null : form}
        onDone={() => setForm(null)}
      />
    );
  }

  if (memories.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <Brain className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-[12px] text-muted">No project memory yet.</p>
        <p className="mt-0.5 text-[11px] text-faint">
          Durable facts agents record (or you add) appear here and are injected into every new chat.
        </p>
        <div className="mt-3 flex justify-center">
          <Button size="xs" variant="subtle" leftIcon={<Plus />} onClick={() => setForm("new")}>
            New memory
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] text-faint">
          {memories.length} {memories.length === 1 ? "memory" : "memories"}
        </span>
        <Button size="xs" variant="subtle" leftIcon={<Plus />} onClick={() => setForm("new")}>
          New
        </Button>
      </div>
      {memories.map((m) => (
        <MemoryCard key={m.name} memory={m} onEdit={() => setForm(m)} />
      ))}
    </div>
  );
}
