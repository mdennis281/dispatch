import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  SECRET_NAME_RE,
  type SecretRefreshReport,
  type SecretScope,
  type SecretSummary,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Spinner } from "../ui/Spinner.js";

type Row = SecretSummary & { usedBy: string[] };

function reportLine(r: SecretRefreshReport | null): string {
  if (!r) return "";
  const parts = [
    r.mcpServers.length ? `${r.mcpServers.length} MCP server(s) reloaded` : "",
    r.chatsRefreshed.length ? `${r.chatsRefreshed.length} live chat(s) reconnected` : "",
    r.subAppsRestarted.length ? `${r.subAppsRestarted.length} sub-app(s) restarted` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing references it yet";
}

/** A `usedBy` entry is `projectId:mcp:name` — the project prefix is noise inside one project's pane. */
function consumerLabel(c: string): string {
  const parts = c.split(":");
  return parts.length >= 3 ? `${parts[1]} ${parts.slice(2).join(":")}` : c;
}

/**
 * Settings → Secrets. Lists names, scopes and consumers; adds, replaces and
 * deletes. It can't SHOW a value because the server has no route that returns
 * one — replacing is the only edit.
 */
export function SecretsPane({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [missing, setMissing] = useState<Array<{ name: string; usedBy: string[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<SecretScope>("project");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.secrets.list(projectId ?? undefined);
      setRows(res.secrets);
      setMissing(res.missing);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const nameValid = SECRET_NAME_RE.test(name);
  const effectiveScope: SecretScope = projectId ? scope : "global";

  const save = async (target?: { name: string; scope: SecretScope }) => {
    const n = target?.name ?? name;
    const sc = target?.scope ?? effectiveScope;
    if (!SECRET_NAME_RE.test(n) || !value) return;
    setBusy(`save:${n}`);
    setError(null);
    try {
      const res = await api.secrets.put({
        name: n,
        scope: sc,
        ...(sc === "project" && projectId ? { projectId } : {}),
        value,
      });
      setValue("");
      setName("");
      setNotice(`Saved ${n} — ${reportLine(res.refresh)}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: Row) => {
    const id = `${row.scope}:${row.name}`;
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    setBusy(`del:${id}`);
    try {
      const res = await api.secrets.remove({
        name: row.name,
        scope: row.scope,
        ...(row.projectId ? { projectId: row.projectId } : {}),
      });
      setNotice(`Deleted ${row.name}${res.refresh ? ` — ${reportLine(res.refresh)}` : ""}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const inputCls = cn(
    "min-w-0 rounded-md border border-line bg-inset px-2.5 py-1.5",
    "cm-mono text-xs text-secondary placeholder:font-sans placeholder:text-faint",
    "focus:border-accent-line focus:outline-none disabled:opacity-60",
  );

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 [&_svg]:size-4">
          <KeyRound className="shrink-0 text-accent" />
          <h3 className="text-base font-semibold text-primary">Secrets</h3>
          <Chip tone={rows.length ? "accent" : "muted"} mono>
            {rows.length}
          </Chip>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          Credentials for MCP servers and sub-apps, kept out of the repo and every transcript.
          Reference one as <span className="cm-mono">{"${secret:NAME}"}</span> in an MCP server&rsquo;s
          env or headers, or a sub-app&rsquo;s env. Values are encrypted on the Dispatch host and
          can be replaced, never read back. Agents ask for them with{" "}
          <span className="cm-mono">secret_request</span>, which puts this same field in front of you.
        </p>
      </div>

      {missing.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-warn">
            <AlertTriangle className="size-3.5" /> Referenced but not set
          </div>
          {missing.map((m) => (
            <div key={m.name} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="cm-mono text-primary">{m.name}</span>
              <span className="text-muted">used by {m.usedBy.map(consumerLabel).join(", ")}</span>
              <Button variant="link" size="sm" className="ml-auto" onClick={() => setName(m.name)}>
                Set it
              </Button>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Spinner size={14} />
      ) : rows.length > 0 ? (
        <ul className="divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-panel-2/40">
          {rows.map((row) => {
            const id = `${row.scope}:${row.name}`;
            return (
              <li key={id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="cm-mono text-sm text-primary">{row.name}</span>
                <Chip tone={row.scope === "global" ? "muted" : "accent"}>{row.scope}</Chip>
                <span className="min-w-0 flex-1 truncate text-2xs text-faint">
                  {row.usedBy.length ? `used by ${row.usedBy.map(consumerLabel).join(", ")}` : "unused"} · updated{" "}
                  {relTime(row.updatedAt)}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setName(row.name);
                    setScope(row.scope);
                  }}
                >
                  Replace
                </Button>
                <Button
                  variant={confirmDelete === id ? "danger" : "link"}
                  size="sm"
                  leftIcon={busy === `del:${id}` ? <Spinner size={10} /> : <Trash2 />}
                  disabled={busy !== null}
                  onClick={() => void remove(row)}
                  onBlur={() => setConfirmDelete(null)}
                >
                  {confirmDelete === id ? "Delete?" : "Delete"}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-faint">No secrets yet.</p>
      )}

      <form
        className="space-y-2 rounded-md border border-line bg-panel-2/40 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.trim())}
            placeholder="NAME"
            aria-label="Secret name"
            spellCheck={false}
            autoComplete="off"
            className={cn(inputCls, "w-48")}
          />
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value"
            aria-label="Secret value"
            spellCheck={false}
            autoComplete="off"
            className={cn(inputCls, "flex-1 basis-48")}
          />
          {projectId && (
            <SegmentedControl<SecretScope>
              value={scope}
              onChange={setScope}
              size="sm"
              segments={[
                { value: "project", label: "This project" },
                { value: "global", label: "All projects" },
              ]}
            />
          )}
          <Button
            type="submit"
            variant="default"
            size="sm"
            leftIcon={busy?.startsWith("save:") ? <Spinner size={10} /> : <Plus />}
            disabled={busy !== null || !nameValid || !value}
          >
            {rows.some((r) => r.name === name && r.scope === effectiveScope) ? "Replace" : "Add"}
          </Button>
        </div>
        {name && !nameValid && (
          <p className="text-2xs text-danger">Letters, digits and underscores, starting with a letter or underscore.</p>
        )}
      </form>

      {notice && <p className="text-2xs text-muted">{notice}</p>}
      {error && (
        <div className="flex items-start gap-1.5 text-2xs leading-snug text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
