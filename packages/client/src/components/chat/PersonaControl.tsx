import { useEffect, useState } from "react";
import { Bot, Check, Settings2 } from "lucide-react";
import type { Chat, Persona } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { useChats } from "../../stores/chats.js";
import { Button } from "../ui/Button.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { TaskLauncherDialog } from "../tasks/TaskLauncherDialog.js";

export function PersonaControl({ chat }: { chat: Chat }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [configure, setConfigure] = useState(false);
  const active = personas.find((p) => p.id === chat.personaId);
  const busy = saving || ["running", "queued", "waiting", "awaiting-input"].includes(chat.status ?? "idle");

  async function refresh() {
    try {
      setPersonas(await api.personas.list(chat.projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setPersonas([]);
    api.personas.list(chat.projectId).then((items) => {
      if (!cancelled) {
        setPersonas(items);
        setError(null);
      }
    }).catch((err) => {
      if (!cancelled) setError(String(err));
    });
    return () => { cancelled = true; };
  }, [chat.projectId]);

  async function select(personaId: string | null) {
    setSaving(true);
    try {
      const saved = await api.personas.select(chat.id, personaId);
      useChats.getState().upsertChat(saved);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-3 pb-2 text-xs">
      <Popover
        align="start"
        width={300}
        className="p-1"
        trigger={({ toggle }) => (
          <Button
            variant="ghost"
            aria-label={`Persona: ${active?.name ?? chat.personaId ?? "Off"}`}
            onClick={() => { void refresh(); toggle(); }}
            className="flex min-h-8 max-w-full items-center gap-1.5 rounded px-1 text-muted hover:bg-active hover:text-primary"
          >
            <Bot className="size-3.5 shrink-0" />
            <span className="truncate">Persona: {active?.name ?? chat.personaId ?? "Off"}</span>
          </Button>
        )}
      >
        {(close) => (
          <>
            <div className="px-2 py-1 text-xs text-muted">
              {busy ? "Available after this turn finishes" : "Applies to the next turn"}
            </div>
            <MenuItem
              dense={false}
              active={!chat.personaId}
              disabled={busy}
              icon={!chat.personaId ? <Check className="size-4" /> : undefined}
              onClick={() => { void select(null); close(); }}
            >
              Off
            </MenuItem>
            {personas.map((p) => (
              <MenuItem
                key={p.id}
                dense={false}
                active={p.id === chat.personaId}
                disabled={busy}
                hint={p.scope}
                onClick={() => { void select(p.id); close(); }}
              >
                {p.name}
              </MenuItem>
            ))}
            {active && (
              <details className="px-2 py-2 text-xs text-muted">
                <summary className="cursor-pointer">View persona description</summary>
                <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                  {active.instructions}
                </div>
              </details>
            )}
            <div className="my-1 border-t border-line" />
            <MenuItem
              dense={false}
              icon={<Settings2 className="size-4" />}
              onClick={() => { setConfigure(true); close(); }}
            >
              Configure a persona…
            </MenuItem>
          </>
        )}
      </Popover>
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
      <TaskLauncherDialog
        taskId="config:personas"
        projectId={chat.projectId}
        open={configure}
        onClose={() => setConfigure(false)}
        params={{
          personaId: chat.personaId,
          scope: active?.scope === "global" ? "global" : "project",
        }}
      />
    </div>
  );
}
