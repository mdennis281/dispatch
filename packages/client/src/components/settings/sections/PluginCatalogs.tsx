import { useEffect, useState, type FormEvent } from "react";
import { BookMarked, ExternalLink, Plus, RotateCw, Trash2 } from "lucide-react";
import type { PluginCatalog, PluginCatalogMember, PluginInfo, PluginInspection } from "@dispatch/shared";
import { sameCatalogUrl } from "@dispatch/shared";
import { InlineError, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { StatusDot } from "../../ui/StatusDot.js";
import { Switch } from "../../ui/Switch.js";
import { api } from "../../../lib/api.js";
import { relTime } from "../../../lib/format.js";
import { InspectionReport } from "./PluginInspectPanel.js";

/**
 * Settings → Plugins → Catalogs: the repositories the pane lists plugins
 * from (plugin-catalog.ts). The built-in one can be switched off but has no
 * Remove — it is not stored, so there would be nothing to remove.
 */

/** "Refreshed 2h ago" — or the failure, which wins: a stale listing should say it is stale. */
export function catalogStateLine(c: PluginCatalog): string {
  if (!c.enabled) return "Switched off";
  if (c.refreshing) return "Refreshing…";
  if (c.error) return c.refreshedAt ? `Refresh failed — showing ${relTime(c.refreshedAt)}'s listing` : "Could not be read";
  if (c.refreshedAt) return `Refreshed ${relTime(c.refreshedAt)}`;
  return "Not read yet";
}

/**
 * The catalog listing an installed plugin, if any. Preferred: the catalog it
 * was INSTALLED from (same URL and subdir). Else any catalog listing that id —
 * which is how a copy installed from an old URL finds its new home.
 */
export function catalogMemberFor(
  plugin: PluginInfo,
  catalogs: PluginCatalog[],
): { catalog: PluginCatalog; member: PluginCatalogMember } | undefined {
  const src = plugin.source?.type === "git" ? plugin.source : undefined;
  let fallback: { catalog: PluginCatalog; member: PluginCatalogMember } | undefined;
  for (const catalog of catalogs) {
    if (!catalog.enabled) continue;
    for (const member of catalog.plugins) {
      if (member.id !== plugin.id) continue;
      if (src && sameCatalogUrl(src.url, catalog.url) && src.subdir === member.subdir) return { catalog, member };
      fallback ??= { catalog, member };
    }
  }
  return fallback;
}

export function CatalogManager({
  catalogs,
  onChange,
  onRemoved,
}: {
  catalogs: PluginCatalog[];
  onChange: (next: PluginCatalog) => void;
  onRemoved: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError(null);
    try {
      onChange(await api.pluginCatalogs.add(url.trim()));
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-md border border-line-soft px-3 py-2.5" data-testid="plugin-catalogs">
      <div>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-primary [&_svg]:size-4 [&_svg]:text-muted">
          <BookMarked />
          Catalogs
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          Repositories Dispatch lists plugins from. Each one is read every few hours and on Refresh. Nothing is
          installed until you open a plugin and press Install.
        </p>
      </div>
      <div className="divide-y divide-line-soft">
        {catalogs.map((c) => (
          <CatalogRow key={c.id} catalog={c} onChange={onChange} onRemoved={() => onRemoved(c.id)} />
        ))}
      </div>
      <form className="flex flex-wrap items-center gap-1.5" onSubmit={(e) => void add(e)}>
        <TextInput
          mono
          className="min-w-0 flex-1 basis-56"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/plugins"
          aria-label="Catalog URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <Button
          type="submit"
          variant="default"
          size="sm"
          leftIcon={adding ? <Spinner size={12} /> : <Plus />}
          disabled={adding || !url.trim()}
        >
          {adding ? "Reading…" : "Add catalog"}
        </Button>
      </form>
      <InlineError message={error} />
    </div>
  );
}

function CatalogRow({
  catalog: c,
  onChange,
  onRemoved,
}: {
  catalog: PluginCatalog;
  onChange: (next: PluginCatalog) => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState<"toggle" | "refresh" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: "toggle" | "refresh" | "remove", fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1 py-2 first:pt-0 last:pb-0" data-testid={`plugin-catalog-${c.id}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium text-secondary">{c.label}</span>
            {c.builtin && <Chip tone="muted">built-in</Chip>}
            {c.enabled && (
              <span className="text-2xs text-faint">
                {c.plugins.length} plugin{c.plugins.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
            <StatusDot tone={!c.enabled ? "muted" : c.error ? "warn" : c.refreshedAt ? "success" : "muted"} />
            <span className="truncate">{catalogStateLine(c)}</span>
            <a
              href={c.browseUrl ?? c.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-0.5 truncate cm-mono hover:text-muted [&_svg]:size-3 [&_svg]:shrink-0"
              title={c.url}
            >
              {c.url.replace(/^https:\/\//, "")}
              <ExternalLink />
            </a>
          </div>
        </div>
        <IconButton
          tip={`Refresh ${c.label}`}
          disabled={!c.enabled || busy !== null || c.refreshing}
          onClick={() => void run("refresh", async () => onChange(await api.pluginCatalogs.refresh(c.id)))}
        >
          {busy === "refresh" || c.refreshing ? <Spinner size={12} /> : <RotateCw />}
        </IconButton>
        {!c.builtin && (
          <IconButton
            tip={`Remove ${c.label}`}
            disabled={busy !== null}
            onClick={() =>
              void run("remove", async () => {
                // Removing a catalog uninstalls nothing — say so, since the
                // plugins it listed vanish from the browse list.
                if (!confirm(`Remove the catalog "${c.label}"? Plugins installed from it stay installed and keep updating from their own source.`)) return;
                await api.pluginCatalogs.remove(c.id);
                onRemoved();
              })
            }
          >
            <Trash2 />
          </IconButton>
        )}
        <Switch
          checked={c.enabled}
          onChange={(v) => void run("toggle", async () => onChange(await api.pluginCatalogs.setEnabled(c.id, v)))}
          label=""
          ariaLabel={`${c.enabled ? "Switch off" : "Switch on"} ${c.label}`}
          disabled={busy !== null}
        />
      </div>
      {c.enabled && c.error && <p className="cm-mono text-2xs break-words text-warn">{c.error}</p>}
      {c.enabled && c.manifestErrors.length > 0 && (
        <p className="text-2xs text-warn">dispatch-plugins.yaml: {c.manifestErrors.join("; ")}</p>
      )}
      <InlineError message={error} />
    </div>
  );
}

/**
 * The full report of one plugin a catalog lists — the same `InspectionReport`
 * a pasted URL gets, so opening a plugin from a catalog skips nothing that
 * reading it by hand would have shown. Its InstallBar installs exactly the
 * commit the catalog was read at.
 */
export function CatalogPluginReport({
  catalog,
  subdir,
  reloadKey,
  onInstalled,
}: {
  catalog: PluginCatalog;
  subdir: string;
  /** Bumped by the parent to re-read (after an install, a refresh). */
  reloadKey?: unknown;
  onInstalled: () => void;
}) {
  const [report, setReport] = useState<PluginInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api.pluginCatalogs
      .plugin(catalog.id, subdir)
      .then((r) => live && setReport(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [catalog.id, catalog.sha, subdir, reloadKey]);

  if (error) return <InlineError message={error} />;
  if (!report) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted">
        <Spinner size={12} /> Reading {catalog.label}…
      </div>
    );
  }
  return <InspectionReport key={report.source.sha} report={report} onInstalled={onInstalled} />;
}
