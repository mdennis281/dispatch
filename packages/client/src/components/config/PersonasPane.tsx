import { useEffect, useState } from "react";
import type { Persona } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { TaskLauncherDialog } from "../tasks/TaskLauncherDialog.js";

export function PersonasPane({ projectId }: { projectId: string | null }) {
  const [items, setItems] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ personaId?: string; scope?: string } | null>(null);

  useEffect(() => {
    setItems([]);
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    const refresh = () => api.personas.list(projectId).then((rows) => {
      if (!cancelled) {
        setItems(rows);
        setError(null);
      }
    }).catch((err) => {
      if (!cancelled) setError(String(err));
    });
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [projectId]);

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-primary">Personas</h3>
      <p className="text-xs text-muted">
        Optional roles selected in each chat. Off by default. Project descriptions override
        global descriptions of the same name.
      </p>
      <Button disabled={!projectId} onClick={() => setEditing({})}>Configure a persona</Button>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {items.map((p) => (
        <div key={p.id} className="space-y-2 rounded-md border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-primary">
              {p.name} <span className="text-xs text-muted">· {p.scope}</span>
            </span>
            <Button
              variant="ghost"
              onClick={() => setEditing({
                personaId: p.id,
                scope: p.scope === "global" ? "global" : "project",
              })}
            >
              Configure with AI
            </Button>
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">View description</summary>
            <p className="mt-2 whitespace-pre-wrap">{p.instructions}</p>
          </details>
        </div>
      ))}
      {editing && (
        <TaskLauncherDialog
          taskId="config:personas"
          projectId={projectId}
          open
          onClose={() => setEditing(null)}
          params={editing}
        />
      )}
    </div>
  );
}
