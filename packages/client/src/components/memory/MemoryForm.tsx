import { useState } from "react";
import { Check, X } from "lucide-react";
import type { ProjectMemory, MemoryType } from "@cm/shared";
import { useMemory } from "../../stores/memory.js";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { type Tone } from "../ui/Chip.js";
import { Select } from "../ui/Select.js";
import { cn } from "../../lib/cn.js";

/** Per-type chip styling + label (matches the recorded memory kinds). */
export const TYPE_META: Record<MemoryType, { label: string; tone: Tone }> = {
  user: { label: "user", tone: "accent" },
  feedback: { label: "feedback", tone: "warn" },
  project: { label: "project", tone: "success" },
  reference: { label: "reference", tone: "muted" },
};

export const TYPE_OPTIONS = (Object.keys(TYPE_META) as MemoryType[]).map((value) => ({
  value,
  label: TYPE_META[value].label,
}));

const inputCls =
  "h-7 w-full rounded-md border border-line bg-inset px-2 text-[12px] text-primary outline-none " +
  "placeholder:text-faint focus:border-line-strong";

/** Create/edit form. `initial` set → edit (name is the fixed identity). Shared by
 *  the top-level Memory view (and previously the per-chat panel). */
export function MemoryForm({
  projectId,
  initial,
  onDone,
}: {
  projectId: string;
  initial: ProjectMemory | null;
  onDone: (saved?: ProjectMemory) => void;
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
      onDone(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save memory.");
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
          {editing ? "Edit memory" : "New memory"}
        </span>
        <IconButton size="sm" tip="Cancel" onClick={() => onDone()}>
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
          placeholder="One-line summary (the retrieval signal — keep it specific)"
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          placeholder="The full fact, in markdown…  Link related memories with [[their-name]]."
          className={cn(
            inputCls,
            "h-auto min-h-48 resize-y py-1.5 cm-mono !text-[11.5px] leading-relaxed",
          )}
        />
      </label>

      {error && <p className="text-[11px] text-danger">{error}</p>}

      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button size="xs" variant="ghost" onClick={() => onDone()}>
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
