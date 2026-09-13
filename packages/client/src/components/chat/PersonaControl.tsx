import { useEffect, useRef, useState } from "react";
import { Check, Drama, Settings2 } from "lucide-react";
import type { Chat, Persona } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { useChats } from "../../stores/chats.js";
import { MenuItem } from "../ui/Popover.js";
import { TaskLauncherDialog } from "../tasks/TaskLauncherDialog.js";

const BUSY_STATUSES = ["running", "queued", "waiting", "awaiting-input"];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type PersonaPicker = ReturnType<typeof usePersonaPicker>;

/**
 * Persona state for one chat, owned by the composer. The picker used to be its
 * own component rendered as a full-width "Persona: Off" row between the editor
 * and the toolbar — permanent height on every chat for a feature that is off by
 * default. It is a toolbar control now, which means two surfaces (the toolbar
 * popover and the options menu) share these rows, so the state lives in a hook
 * rather than inside either one.
 *
 * Its error is its own, not the composer's send/upload slot: sharing that slot
 * let a successful pick wipe an unrelated "Image upload failed". And because the
 * composer is not keyed per chat, everything per-chat here resets on a chat
 * switch, and a save that lands after one is dropped rather than reported in the
 * chat you moved to.
 */
export function usePersonaPicker(chat: Chat) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const chatIdRef = useRef(chat.id);
  chatIdRef.current = chat.id;
  const active = personas.find((p) => p.id === chat.personaId);
  const busy = saving || BUSY_STATUSES.includes(chat.status ?? "idle");
  // Before the list loads, a set persona still has a name to show: its id.
  const label = active?.name ?? chat.personaId ?? null;

  useEffect(() => {
    setSaving(false);
    setError(null);
    setConfiguring(false);
  }, [chat.id]);

  useEffect(() => {
    let cancelled = false;
    setPersonas([]);
    api.personas
      .list(chat.projectId)
      .then((items) => {
        if (!cancelled) setPersonas(items);
      })
      .catch((err) => {
        if (!cancelled) setError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chat.projectId]);

  /** Re-read on open, so a persona authored in another tab shows up. */
  async function refresh() {
    try {
      setPersonas(await api.personas.list(chat.projectId));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function select(personaId: string | null) {
    const chatId = chat.id;
    setSaving(true);
    try {
      const saved = await api.personas.select(chatId, personaId);
      // The store is keyed by id, so this is right even after a chat switch.
      useChats.getState().upsertChat(saved);
      if (chatIdRef.current === chatId) setError(null);
    } catch (err) {
      if (chatIdRef.current === chatId) setError(messageOf(err));
    } finally {
      if (chatIdRef.current === chatId) setSaving(false);
    }
  }

  return {
    chat,
    personas,
    active,
    busy,
    label,
    error,
    dismissError: () => setError(null),
    refresh,
    select,
    configuring,
    setConfiguring,
  };
}

/** The persona list, shared by the toolbar popover and the options menu. */
export function PersonaRows({
  picker,
  close,
  dense,
}: {
  picker: PersonaPicker;
  close: () => void;
  dense: boolean;
}) {
  const { chat, personas, active, busy } = picker;
  return (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-2xs text-faint">
        {busy ? "Available after this turn finishes" : "Applies to the next turn"}
      </div>
      <MenuItem
        dense={dense}
        icon={<Drama />}
        active={!chat.personaId}
        disabled={busy}
        onClick={() => {
          void picker.select(null);
          close();
        }}
      >
        <span className="flex items-center gap-2">
          Off
          {!chat.personaId && <Check className="size-3 text-accent" />}
        </span>
      </MenuItem>
      {personas.map((p) => (
        <MenuItem
          key={p.id}
          dense={dense}
          icon={<Drama />}
          active={p.id === chat.personaId}
          disabled={busy}
          hint={p.scope}
          onClick={() => {
            void picker.select(p.id);
            close();
          }}
        >
          <span className="flex items-center gap-2">
            {p.name}
            {p.id === chat.personaId && <Check className="size-3 text-accent" />}
          </span>
        </MenuItem>
      ))}
      {active && (
        <details className="px-2 py-2 text-xs text-muted">
          <summary className="cursor-pointer">View persona description</summary>
          <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{active.instructions}</div>
        </details>
      )}
      <div className="my-1 h-px bg-line" />
      <MenuItem
        dense={dense}
        icon={<Settings2 />}
        onClick={() => {
          picker.setConfiguring(true);
          close();
        }}
      >
        Configure a persona…
      </MenuItem>
    </div>
  );
}

/**
 * Mounted once at the composer root, not inside either menu: both menus close
 * as the dialog opens, and a dialog owned by a closed popover would unmount
 * with it.
 */
export function PersonaConfigureDialog({ picker }: { picker: PersonaPicker }) {
  return (
    <TaskLauncherDialog
      taskId="config:personas"
      projectId={picker.chat.projectId}
      open={picker.configuring}
      onClose={() => picker.setConfiguring(false)}
      params={{
        personaId: picker.chat.personaId,
        scope: picker.active?.scope === "global" ? "global" : "project",
      }}
    />
  );
}
