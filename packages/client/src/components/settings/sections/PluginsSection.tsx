import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Copy, FolderOpen, Link2, RefreshCw, RotateCw, Save, Trash2, Unlink2 } from "lucide-react";
import type {
  PluginAutoUpdate,
  PluginCatalog,
  PluginCatalogMember,
  PluginCatalogsStatus,
  PluginCleanupSummary,
  PluginInfo,
  PluginOAuthStatus,
  PluginStatus,
  PluginUninstallResult,
  PluginUpdateStatus,
} from "@dispatch/shared";
import { Field, InlineError, TextArea, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Chip } from "../../ui/Chip.js";
import { RowButton } from "../../ui/RowButton.js";
import { Select } from "../../ui/Select.js";
import { Spinner } from "../../ui/Spinner.js";
import { StatusDot, type DotTone } from "../../ui/StatusDot.js";
import { Switch } from "../../ui/Switch.js";
import { sameSettingsValue } from "@dispatch/shared";
import { api } from "../../../lib/api.js";
import { onServerEvent } from "../../../lib/eventTap.js";
import { useCopyId } from "../../../lib/useCopyId.js";
import { useNotices } from "../../../stores/notices.js";
import { coerceNumber, displayValue, fieldsFromSchema, type SettingsField } from "./pluginSettingsForm.js";
import { PluginInspectPanel } from "./PluginInspectPanel.js";
import { PluginSourceLine, PluginUninstallDialog, PluginUpdatePanel, type CheckState } from "./PluginLifecycle.js";
import { CatalogManager, CatalogPluginReport, catalogMemberFor, catalogStateLine } from "./PluginCatalogs.js";

/**
 * Settings → Plugins: a LIST — what is installed, then what the catalogs
 * offer that is not — and a DETAIL page per plugin, reached by clicking a row.
 *
 * It used to be one stacked card per installed plugin with everything open at
 * once. That stopped scaling the moment there was more than one source of
 * plugins to show: a browse list of cards each carrying a settings form, an
 * OAuth row and an update panel is a wall. So the list carries only what you
 * decide on (status, version, "update available"), and the card — unchanged —
 * is the detail page, with the catalog's full report under it when a catalog
 * lists that plugin.
 *
 * Saves through its own routes on every change rather than through the
 * settings draft, like Permissions does, because the toggle and a plugin's
 * settings are owned by `PUT /api/plugins/:id/*` — targeted patches a plugin
 * can observe live (`ctx.settings.onChange`). A draft would hand the plugin a
 * stale copy the next time anyone saved a theme.
 */
type View = { kind: "list" } | { kind: "installed"; id: string } | { kind: "available"; catalogId: string; subdir: string };

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held here, not per card, so "Check all" and a row's own button share one
  // answer. The pane itself never polls; the server's background pass does,
  // and its answers seed this map on load (see `seed` below).
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [background, setBackground] = useState<PluginUpdateStatus | null>(null);
  const [catalogs, setCatalogs] = useState<PluginCatalogsStatus | null>(null);
  const [refreshingCatalogs, setRefreshingCatalogs] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  // Bumped after an install so an open catalog report re-reads its
  // `installed` block instead of still offering Install.
  const [reloadKey, setReloadKey] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const pushToast = useNotices((s) => s.push);

  const load = useCallback(() => {
    setError(null);
    api.plugins
      .list()
      .then(setPlugins)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Owner-only; anyone else simply gets no background answers to show.
    api.plugins
      .updates()
      .then(setBackground)
      .catch(() => setBackground(null));
    // Owner-only too, and from the server's cache: no fetch happens here.
    api.pluginCatalogs
      .list()
      .then(setCatalogs)
      .catch(() => setCatalogs(null));
  }, []);
  useEffect(load, [load]);
  // A plugin writes its own settings too (`ctx.settings.set`), and so does the
  // other instance; the row follows, so the form shows what is stored now.
  useEffect(
    () =>
      onServerEvent("plugin-settings", (evt) =>
        setPlugins((rows) => rows?.map((p) => (p.id === evt.plugin ? { ...p, settings: evt.settings } : p)) ?? rows),
      ),
    [],
  );

  // A background answer is shown only while it still describes what is
  // installed: one checked against an older commit (updated or reinstalled
  // since) would offer an update that already happened. A row's own Check
  // always wins over it.
  useEffect(() => {
    if (!background || !plugins) return;
    setChecks((c) => {
      const next = { ...c };
      for (const p of plugins) {
        const b = background.checks[p.id];
        if (!b || next[p.id] || b.status !== "available") continue;
        if (p.source?.type === "git" && b.current?.sha === p.source.sha) next[p.id] = b;
      }
      return next;
    });
  }, [background, plugins]);

  // A detail page opens at its top, not at the scroll offset the list was at.
  const open = (next: View) => {
    setView(next);
    requestAnimationFrame(() => top.current?.scrollIntoView({ block: "start" }));
  };
  const back = () => open({ kind: "list" });

  const replace = (next: PluginInfo) =>
    setPlugins((rows) => rows?.map((p) => (p.id === next.id ? next : p)) ?? rows);

  const installed = () => {
    load();
    setReloadKey((k) => k + 1);
  };

  const check = useCallback(async (id: string) => {
    setChecks((c) => ({ ...c, [id]: "checking" }));
    try {
      const res = await api.plugins.checkUpdate(id);
      setChecks((c) => ({ ...c, [id]: res }));
    } catch (e) {
      setChecks((c) => ({
        ...c,
        [id]: { id, status: "error", origin: "url", message: e instanceof Error ? e.message : String(e), checkedAt: Date.now() },
      }));
    }
  }, []);

  const checkable = plugins?.filter((p) => p.origin === "url") ?? [];
  const checkingAll = checkable.some((p) => checks[p.id] === "checking");
  const checkAll = async () => {
    // A few at a time: each check is an ls-remote, and an available one a
    // tarball download plus two scans.
    const queue = [...checkable];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await check(p.id);
    };
    await Promise.all([worker(), worker(), worker()]);
  };

  const refreshCatalogs = async () => {
    setRefreshingCatalogs(true);
    try {
      setCatalogs(await api.pluginCatalogs.refreshAll());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingCatalogs(false);
    }
  };

  const replaceCatalog = (next: PluginCatalog) =>
    setCatalogs(
      (s) =>
        s && {
          ...s,
          catalogs: s.catalogs.some((c) => c.id === next.id)
            ? s.catalogs.map((c) => (c.id === next.id ? next : c))
            : [...s.catalogs, next],
        },
    );

  const removed = (p: PluginInfo, res: PluginUninstallResult) => {
    setPlugins((rows) => rows?.filter((r) => r.id !== p.id) ?? rows);
    setChecks(({ [p.id]: _gone, ...rest }) => rest);
    back();
    // The catalogs' rows carry `installed`; one just stopped being true.
    api.pluginCatalogs.list().then(setCatalogs).catch(() => {});
    const what = res.removed === "link" ? "Unlinked" : "Uninstalled";
    const data = res.purged ? " and deleted its data" : "";
    pushToast({ level: "info", text: `${what} ${p.name}${data}.${res.note ? ` ${res.note}` : ""}` });
  };

  if (plugins === null && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  const catalogList = catalogs?.catalogs ?? [];

  /* ---------------------------------------------------------- detail pages */

  if (view.kind === "installed") {
    const p = plugins?.find((x) => x.id === view.id);
    if (p) {
      const listed = catalogMemberFor(p, catalogList);
      return (
        <div ref={top} className="space-y-3">
          <BackBar onBack={back} />
          <PluginCard
            plugin={p}
            onChange={replace}
            check={checks[p.id]}
            onCheck={() => void check(p.id)}
            onRemoved={(res) => removed(p, res)}
          />
          {listed && (
            <section className="space-y-1.5" data-testid="plugin-catalog-report">
              <GroupHeading title={`Listed in ${listed.catalog.label}`}>
                <span className="text-2xs text-faint">{catalogStateLine(listed.catalog)}</span>
              </GroupHeading>
              <CatalogPluginReport
                catalog={listed.catalog}
                subdir={listed.member.subdir}
                reloadKey={reloadKey}
                onInstalled={installed}
              />
            </section>
          )}
        </div>
      );
    }
  }

  if (view.kind === "available") {
    const catalog = catalogList.find((c) => c.id === view.catalogId);
    const member = catalog?.plugins.find((m) => m.subdir === view.subdir);
    if (catalog && member) {
      const nowInstalled = member.id ? plugins?.find((x) => x.id === member.id) : undefined;
      return (
        <div ref={top} className="space-y-3">
          <BackBar onBack={back}>
            {nowInstalled && (
              <Button
                variant="ghost"
                size="sm"
                rightIcon={<ChevronRight />}
                onClick={() => open({ kind: "installed", id: nowInstalled.id })}
              >
                Manage installed plugin
              </Button>
            )}
          </BackBar>
          <p className="text-2xs text-faint">
            From {catalog.label} · {catalogStateLine(catalog)}
          </p>
          <CatalogPluginReport catalog={catalog} subdir={member.subdir} reloadKey={reloadKey} onInstalled={installed} />
        </div>
      );
    }
  }

  /* ------------------------------------------------------------------ list */

  const installedIds = new Set(plugins?.map((p) => p.id) ?? []);
  const enabledCatalogs = catalogList.filter((c) => c.enabled);

  return (
    <div ref={top} className="space-y-5">
      <InlineError message={error} />

      <section className="space-y-1.5" data-testid="plugins-installed">
        <GroupHeading title="Installed" count={plugins?.length}>
          {checkable.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={checkingAll ? <Spinner size={12} /> : <RotateCw />}
              disabled={checkingAll}
              onClick={() => void checkAll()}
              title="Check every plugin installed from a URL against its source"
            >
              {checkingAll ? "Checking…" : "Check all for updates"}
            </Button>
          )}
          <Button variant="ghost" size="sm" leftIcon={<RefreshCw />} onClick={load} title="Re-read the installed list">
            Reload
          </Button>
        </GroupHeading>
        {plugins && plugins.length === 0 ? (
          <div className="rounded-md border border-line-soft px-3 py-4 text-xs leading-relaxed text-muted">
            <p className="font-medium text-secondary">No plugins installed.</p>
            <p className="mt-1">
              Pick one from a catalog below, inspect one from a URL, or run{" "}
              <code className="text-fg">dispatch plugin add &lt;path&gt;</code>, then restart.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line-soft overflow-hidden rounded-md border border-line-soft">
            {plugins?.map((p) => (
              <InstalledRow
                key={p.id}
                plugin={p}
                check={checks[p.id]}
                listed={catalogMemberFor(p, catalogList)?.member}
                onOpen={() => open({ kind: "installed", id: p.id })}
              />
            ))}
          </div>
        )}
        {checkable.length > 0 && background && (
          <p className="text-2xs text-faint" data-testid="plugin-background-check">
            {backgroundLine(background)}
          </p>
        )}
      </section>

      {catalogs && (
        <section className="space-y-3" data-testid="plugins-available">
          <GroupHeading title="Available">
            {enabledCatalogs.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                leftIcon={refreshingCatalogs ? <Spinner size={12} /> : <RotateCw />}
                disabled={refreshingCatalogs}
                onClick={() => void refreshCatalogs()}
                title="Re-read every catalog that is switched on"
              >
                {refreshingCatalogs ? "Refreshing…" : "Refresh catalogs"}
              </Button>
            )}
          </GroupHeading>
          {enabledCatalogs.length === 0 && (
            <p className="text-xs text-muted">Every catalog is switched off — switch one on under Catalogs below.</p>
          )}
          {enabledCatalogs.map((c) => (
            <AvailableGroup
              key={c.id}
              catalog={c}
              installedIds={installedIds}
              onOpen={(m) => open({ kind: "available", catalogId: c.id, subdir: m.subdir })}
            />
          ))}
        </section>
      )}

      {catalogs && (
        <CatalogManager
          catalogs={catalogList}
          onChange={replaceCatalog}
          onRemoved={(id) => setCatalogs((s) => s && { ...s, catalogs: s.catalogs.filter((c) => c.id !== id) })}
        />
      )}
      <PluginInspectPanel onInstalled={installed} />
    </div>
  );
}

/* ------------------------------------------------------------ list parts */

function GroupHeading({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1">
      <h3 className="mr-auto text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
        {title}
        {count !== undefined && <span className="font-normal normal-case tracking-normal"> · {count}</span>}
      </h3>
      {children}
    </div>
  );
}

function BackBar({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" size="sm" leftIcon={<ArrowLeft />} onClick={onBack}>
        All plugins
      </Button>
      {children}
    </div>
  );
}

/**
 * "Update to v1.2.0" when one is known — from a Check (the row's own or the
 * background pass), or from a catalog listing a newer version than the one
 * installed. The catalog answer is only a version compare; Check is what
 * diffs what the update would ask for, so the detail page is where to act.
 */
function updateBadge(check: CheckState | undefined, listed: PluginCatalogMember | undefined): string | null {
  if (check && check !== "checking" && check.status === "available") {
    const v = check.target?.version;
    return v ? `Update to v${v}` : "Update available";
  }
  if (listed?.installed?.comparison === "newer" && listed.version) return `v${listed.version} available`;
  return null;
}

function InstalledRow({
  plugin: p,
  check,
  listed,
  onOpen,
}: {
  plugin: PluginInfo;
  check?: CheckState;
  listed?: PluginCatalogMember;
  onOpen: () => void;
}) {
  const status = statusOf(p);
  const update = updateBadge(check, listed);
  return (
    <RowButton className="flex w-full items-center gap-2 px-3 py-2 hover:bg-hover" onClick={onOpen} data-testid={`plugin-row-${p.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-primary">{p.name}</span>
          {p.version && <Chip mono>v{p.version}</Chip>}
          {p.builtin && <Chip tone="muted">built-in</Chip>}
          {p.origin === "linked" && <Chip tone="muted">linked</Chip>}
          <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
            <StatusDot tone={status.tone} />
            {status.label}
          </span>
          {check === "checking" && <Spinner size={10} />}
          {update && <Chip tone="accent">{update}</Chip>}
          {p.pendingCleanups && <Chip tone="warn">cleanups stuck</Chip>}
        </div>
        {p.description && <p className="mt-0.5 truncate text-xs text-muted">{p.description}</p>}
      </div>
      <ChevronRight className="size-4 shrink-0 text-faint" />
    </RowButton>
  );
}

function AvailableGroup({
  catalog: c,
  installedIds,
  onOpen,
}: {
  catalog: PluginCatalog;
  installedIds: Set<string>;
  onOpen: (m: PluginCatalogMember) => void;
}) {
  // Installed members live in the list above (with their update badge); this
  // is what you could ADD. A member with no id could not be read at all and
  // is shown so its error is seen, not silently dropped.
  const fresh = c.plugins.filter((m) => !m.id || !installedIds.has(m.id));
  return (
    <div className="space-y-1" data-testid={`plugins-available-${c.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-secondary">{c.label}</span>
        <span className="text-2xs text-faint">{catalogStateLine(c)}</span>
      </div>
      {c.error && !c.refreshedAt ? (
        <p className="cm-mono break-words text-2xs text-warn">{c.error}</p>
      ) : !c.refreshedAt ? (
        <p className="text-2xs text-muted">Not read yet — press Refresh catalogs.</p>
      ) : fresh.length === 0 ? (
        <p className="text-2xs text-muted">
          {c.plugins.length === 0
            ? "It lists no plugins."
            : c.plugins.length === 1
              ? "Its one plugin is installed."
              : `All ${c.plugins.length} of its plugins are installed.`}
        </p>
      ) : (
        <div className="divide-y divide-line-soft overflow-hidden rounded-md border border-line-soft">
          {fresh.map((m) => (
            <AvailableRow key={m.subdir} member={m} onOpen={() => onOpen(m)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AvailableRow({ member: m, onOpen }: { member: PluginCatalogMember; onOpen: () => void }) {
  if (m.error) {
    return (
      <div className="px-3 py-2 text-xs">
        <span className="cm-mono text-secondary">{m.subdir}</span>
        <p className="cm-mono text-2xs text-warn">{m.error}</p>
      </div>
    );
  }
  return (
    <RowButton
      className="flex w-full items-center gap-2 px-3 py-2 hover:bg-hover"
      onClick={onOpen}
      data-testid={`plugin-available-${m.id ?? m.subdir}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-primary">{m.name ?? m.id ?? m.subdir}</span>
          {m.version && <Chip mono>v{m.version}</Chip>}
          {!m.installable && (
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary" title={m.refusal}>
              <StatusDot tone="warn" />
              Can&apos;t install here
            </span>
          )}
          {m.capabilities.slice(0, 4).map((cap) => (
            <Chip key={cap} tone="muted">
              {cap}
            </Chip>
          ))}
          {m.capabilities.length > 4 && <span className="text-2xs text-faint">+{m.capabilities.length - 4}</span>}
        </div>
        {m.description && <p className="mt-0.5 truncate text-xs text-muted">{m.description}</p>}
      </div>
      <ChevronRight className="size-4 shrink-0 text-faint" />
    </RowButton>
  );
}

/** "Checked in the background every 6 h · last 2:14 PM" — or why it is not. */
function backgroundLine(s: PluginUpdateStatus): string {
  if (s.intervalHours <= 0) return "Background update checks are off (DISPATCH_PLUGIN_UPDATE_HOURS=0).";
  const at = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const every = `Checked in the background every ${s.intervalHours} h`;
  if (s.running) return `${every} · checking now…`;
  if (s.lastRunAt) return `${every} · last ${at(s.lastRunAt)}`;
  return s.nextRunAt ? `${every} · first check at ${at(s.nextRunAt)}` : every;
}

// Hints are the Select's short right-hand tag, not a sentence — a long one
// pushes the label out of the row. The full meaning is the card's tooltip.
const AUTO_UPDATE_OPTIONS: Array<{ value: PluginAutoUpdate; label: string; hint: string }> = [
  { value: "notify", label: "Notify", hint: "install nothing" },
  { value: "auto", label: "Auto-update", hint: "safe ones only" },
  { value: "off", label: "Off", hint: "manual checks" },
];

/* ------------------------------------------------------------------ card */

const STATUS: Record<PluginStatus, { tone: DotTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  disabled: { tone: "muted", label: "Off" },
  error: { tone: "danger", label: "Failed to start" },
  invalid: { tone: "danger", label: "Invalid manifest" },
  incompatible: { tone: "warn", label: "Incompatible" },
  // A dependency it needs is missing, off or broken; the row's error says which.
  blocked: { tone: "warn", label: "Blocked" },
};

/**
 * An enabled plugin the host has not loaded yet (installed or switched on
 * since boot) reports `disabled`; "Off" beside a switch that is ON read as a
 * contradiction, so the row names what is actually pending.
 */
function statusOf(plugin: PluginInfo): { tone: DotTone; label: string } {
  return plugin.needsRestart && plugin.enabled && plugin.status === "disabled"
    ? { tone: "warn", label: "Restart to load" }
    : STATUS[plugin.status];
}

function PluginCard({
  plugin,
  onChange,
  check,
  onCheck,
  onRemoved,
}: {
  plugin: PluginInfo;
  onChange: (next: PluginInfo) => void;
  check?: CheckState;
  onCheck: () => void;
  onRemoved: (result: PluginUninstallResult) => void;
}) {
  const pushToast = useNotices((s) => s.push);
  const copy = useCopyId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const status = statusOf(plugin);
  // Invalid and incompatible plugins cannot be turned on; the toggle would
  // promise an activation that can never happen.
  const toggleable = plugin.status !== "invalid" && plugin.status !== "incompatible";

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.plugins.setEnabled(plugin.id, enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setAutoUpdate = async (policy: PluginAutoUpdate) => {
    setError(null);
    try {
      onChange(await api.plugins.setAutoUpdate(plugin.id, policy));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reveal = async () => {
    try {
      await api.plugins.reveal(plugin.id);
      pushToast({ level: "info", text: `Opened ${plugin.dir} on the Dispatch host` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5 rounded-md border border-line-soft px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-primary">{plugin.name}</span>
            {plugin.version && <Chip mono>v{plugin.version}</Chip>}
            {/* Ships with Dispatch (Codex, goose): upgraded with the app, never
                installed or removed by hand, so it reads differently from one
                the owner added. */}
            {plugin.builtin && <Chip tone="muted">built-in</Chip>}
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
              <StatusDot tone={status.tone} />
              {status.label}
            </span>
          </div>
          {plugin.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{plugin.description}</p>
          )}
        </div>
        <Switch
          checked={plugin.enabled}
          onChange={(v) => void toggle(v)}
          label=""
          ariaLabel={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
          disabled={busy || !toggleable}
        />
      </div>

      {plugin.error && <InlineError message={plugin.error} />}
      {plugin.pendingCleanups && (
        <PluginCleanupNotice plugin={plugin} pending={plugin.pendingCleanups} onChange={onChange} />
      )}
      {plugin.needsRestart && (
        <p className="text-xs text-warn">
          {plugin.status === "active" ? "Updated" : "Not loaded yet"} — restart Dispatch to load it. Plugins are not
          hot-reloaded.
        </p>
      )}
      <InlineError message={error} />

      <div className="flex flex-wrap items-center gap-1">
        <Chip mono tone="muted">
          {plugin.id}
        </Chip>
        {plugin.capabilities.map((c) => {
          // Declared under optionalCapabilities: granted the same, but the
          // plugin runs without it on a Dispatch that lacks it.
          const optional = plugin.optionalCapabilities?.includes(c);
          return (
            <Chip key={c} tone="accent" {...(optional ? { title: "Optional — granted because this Dispatch has it" } : {})}>
              {c}
              {optional && " (optional)"}
            </Chip>
          );
        })}
        {plugin.secrets?.map((s) => (
          <Chip key={s} tone="warn" mono>
            secret:{s}
          </Chip>
        ))}
        {plugin.capabilities.length === 0 && !plugin.secrets?.length && (
          <span className="text-2xs text-faint">declares no capabilities</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1">
          <PluginSourceLine plugin={plugin} />
        </div>
        {plugin.origin === "url" && plugin.autoUpdate && (
          <span
            className="contents"
            title="Background checks: Notify tells you about an update and installs nothing. Auto-update installs one that asks for nothing new (it loads on the next restart) and tells you about the rest. Off leaves it to Check for updates."
          >
          <Select
            label="Updates"
            options={AUTO_UPDATE_OPTIONS}
            value={plugin.autoUpdate}
            onChange={(v) => void setAutoUpdate(v)}
            align="end"
            width={220}
          />
          </span>
        )}
      </div>
      {check && <PluginUpdatePanel plugin={plugin} check={check} onUpdated={(row) => row && onChange(row)} />}

      {plugin.settingsSchema !== undefined && plugin.status !== "invalid" && (
        <PluginSettingsForm plugin={plugin} onChange={onChange} />
      )}

      {plugin.oauth?.length ? (
        <div className="space-y-1 rounded-md bg-inset/40 px-2.5 py-2">
          {plugin.oauth.map((client) => (
            <PluginOAuthRow key={client.name} plugin={plugin} client={client} onChange={onChange} />
          ))}
        </div>
      ) : null}

      {/* One row: the path shrinks first, and at phone width the actions wrap
          under it rather than squeezing it to nothing. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate cm-mono text-2xs text-faint" title={plugin.dir}>
            {plugin.dir}
          </code>
          <IconButton tip="Copy path" onClick={() => copy(plugin.dir, "Plugin path")}>
            <Copy />
          </IconButton>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <Button variant="ghost" size="sm" leftIcon={<FolderOpen />} onClick={() => void reveal()}>
            Open folder
          </Button>
          {plugin.origin === "url" && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={check === "checking" ? <Spinner size={12} /> : <RotateCw />}
              disabled={check === "checking"}
              onClick={onCheck}
            >
              Check for updates
            </Button>
          )}
          {/* Built-ins ship with the app: no Update (it updates with Dispatch)
              and no Uninstall (the next start would find it again). The switch
              above is the whole of their lifecycle. */}
          {plugin.origin !== "builtin" && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={plugin.origin === "linked" ? <Unlink2 /> : <Trash2 />}
              onClick={() => setUninstalling(true)}
            >
              {plugin.origin === "linked" ? "Unlink" : "Uninstall"}
            </Button>
          )}
        </div>
      </div>
      <PluginUninstallDialog
        plugin={plugin}
        open={uninstalling}
        onClose={() => setUninstalling(false)}
        onRemoved={(res) => {
          setUninstalling(false);
          onRemoved(res);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------- cleanups */

/**
 * Per-chat cleanups this plugin failed — a container a chat delete could not
 * destroy, say — that Dispatch is still retrying. Shown because the only other
 * trace is a server log, and what is stuck is usually something running (and
 * costing) on another machine. Retry runs them now; Forget is for after the
 * owner has cleaned up by hand.
 */
function PluginCleanupNotice({
  plugin,
  pending,
  onChange,
}: {
  plugin: PluginInfo;
  pending: PluginCleanupSummary;
  onChange: (next: PluginInfo) => void;
}) {
  const [busy, setBusy] = useState<"retry" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: "retry" | "forget") => {
    setBusy(what);
    setError(null);
    try {
      if (what === "forget") {
        onChange(await api.plugins.discardCleanups(plugin.id));
        return;
      }
      // The server answers at once and retries in the background (a row can
      // take a minute against an unreachable host), so read the outcome back
      // a few seconds later rather than holding the button on a request.
      await api.plugins.retryCleanups(plugin.id);
      await new Promise((r) => setTimeout(r, 4_000));
      const fresh = (await api.plugins.list()).find((p) => p.id === plugin.id);
      if (fresh) onChange(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const n = pending.count;
  return (
    <div className="space-y-1.5 rounded-md border border-warn-line bg-warn-ghost px-2.5 py-2" role="status">
      <p className="text-xs text-warn">
        {n === 1 ? "1 chat cleanup" : `${n} chat cleanups`} failed and {n === 1 ? "is" : "are"} being retried —
        stuck since {when(pending.oldestAt)}, {pending.attempts} attempt{pending.attempts === 1 ? "" : "s"}. Next try{" "}
        {pending.nextAt <= Date.now() ? "when the plugin is next active" : when(pending.nextAt)}.
      </p>
      {pending.lastError && (
        <p className="cm-mono text-2xs text-muted break-words" title={pending.lastError}>
          {pending.lastError}
        </p>
      )}
      <p className="cm-mono text-2xs text-faint truncate" title={pending.chats.join(", ")}>
        chats: {pending.chats.join(", ")}
        {pending.count > pending.chats.length ? ` +${pending.count - pending.chats.length} more` : ""}
      </p>
      <InlineError message={error} />
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={busy === "retry" ? <Spinner size={12} /> : <RotateCw />}
          disabled={busy !== null || plugin.status !== "active"}
          onClick={() => void run("retry")}
        >
          Retry now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void run("forget")}
          title="Stop retrying. Use this once you have cleaned up by hand; nothing more is run."
        >
          Forget
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- oauth */

/** "Connected until <time>" — or just "Connected" when the provider gave no expiry. */
function oauthConnectedLabel(client: PluginOAuthStatus, now = Date.now()): string {
  if (!client.connected) return "Not connected";
  if (client.expiresAt === undefined) return "Connected";
  if (client.expiresAt <= now) return "Connected — token expired, renews on next use";
  return `Connected until ${new Date(client.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

/**
 * One declared `oauth.clients.<name>`: Connect sends the browser to the
 * provider (the server builds the URL and holds the state); the provider
 * sends it back to `/oauth/callback/<plugin>/<name>`, which lands on this
 * pane with the row updated. Disconnect forgets the tokens here and now.
 */
function PluginOAuthRow({
  plugin,
  client,
  onChange,
}: {
  plugin: PluginInfo;
  client: PluginOAuthStatus;
  onChange: (next: PluginInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || plugin.status !== "active" || !!client.configError;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.plugins.oauthConnect(plugin.id, client.name);
      location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm(`Disconnect "${client.name}"? ${plugin.name} loses its token until you connect again.`)) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.plugins.oauthDisconnect(plugin.id, client.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1" data-testid={`plugin-oauth-${client.name}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="cm-mono text-xs font-medium text-secondary">oauth:{client.name}</span>
            <StatusDot tone={client.connected ? "success" : client.configError ? "warn" : "muted"} />
            <span className="text-2xs text-muted">{oauthConnectedLabel(client)}</span>
          </div>
          {client.configError ? (
            <p className="mt-0.5 text-2xs text-warn">{client.configError}</p>
          ) : client.scopes?.length ? (
            <p className="mt-0.5 cm-mono text-2xs text-faint">{client.scopes.join(" ")}</p>
          ) : null}
        </div>
        {client.connected ? (
          <Button variant="ghost" size="sm" leftIcon={<Unlink2 />} disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : (
          <Button variant="primary" size="sm" leftIcon={<Link2 />} disabled={disabled} onClick={() => void connect()}>
            {busy ? "Opening…" : "Connect"}
          </Button>
        )}
      </div>
      <InlineError message={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ form */

/**
 * The generic settings form. Local edits, one Save: a plugin's `onChange`
 * fires per save, and a plugin that reconnects to a service on every
 * keystroke of its URL field is nobody's idea of a good time.
 *
 * It holds only the keys the owner TOUCHED and saves them as a PATCH. Every
 * other key is read live from `plugin.settings`, so one the plugin writes
 * while this is open (a paired machine, from its own settings section) shows
 * up and is never sent back. The form used to PUT its whole draft, which
 * erased exactly that write.
 */
function PluginSettingsForm({ plugin, onChange }: { plugin: PluginInfo; onChange: (next: PluginInfo) => void }) {
  const { fields, unsupported } = fieldsFromSchema(plugin.settingsSchema);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueOf = (key: string) => (key in edits ? edits[key] : plugin.settings[key]);
  const dirty = Object.keys(edits).some((k) => !sameSettingsValue(edits[k], plugin.settings[k]));

  // `undefined` is kept as an edit: it means "clear this key", sent as `null`.
  const set = (key: string, value: unknown) => setEdits((e) => ({ ...e, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A half-typed number is still a string in the draft; it does not get saved as one.
      const clean = Object.fromEntries(
        Object.entries(edits).filter(([k, v]) => {
          const f = fields.find((x) => x.key === k);
          return !(f && (f.kind === "number" || f.kind === "integer") && typeof v === "string");
        }),
      );
      onChange(await api.plugins.patchSettings(plugin.id, clean));
      setEdits({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!fields.length && !unsupported.length && !plugin.settingsErrors?.length) return null;

  return (
    <div className="space-y-2 rounded-md bg-inset/40 px-2.5 py-2">
      {fields.map((f) => (
        <FieldControl key={f.key} field={f} value={valueOf(f.key)} onChange={(v) => set(f.key, v)} />
      ))}
      {unsupported.length > 0 && (
        <p className="text-2xs text-faint">
          Not editable here ({unsupported.join(", ")}) — set them under <code>plugins.{plugin.id}.settings</code> in
          config.json.
        </p>
      )}
      {plugin.settingsErrors?.length ? (
        <p className="text-2xs text-warn">
          Stored values the plugin's schema refuses — saving other keys still works: {plugin.settingsErrors.join("; ")}
        </p>
      ) : null}
      <InlineError message={error} />
      {dirty && (
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEdits({})}>
            Discard
          </Button>
          <Button variant="primary" size="sm" leftIcon={busy ? <Spinner size={12} /> : <Save />} disabled={busy} onClick={() => void save()}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const shown = displayValue(field, value);
  const hint = field.description;
  switch (field.kind) {
    case "boolean":
      return (
        <div className="flex items-start justify-between gap-3 py-0.5">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">{field.label}</div>
            {hint && <div className="text-2xs text-muted">{hint}</div>}
          </div>
          <Switch checked={shown === true} onChange={(v) => onChange(v)} label="" ariaLabel={field.label} />
        </div>
      );
    case "enum":
      return (
        <Field label={field.label} hint={hint}>
          <Select
            options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
            value={typeof shown === "string" ? shown : (field.options?.[0] ?? "")}
            onChange={(v) => onChange(v)}
          />
        </Field>
      );
    case "number":
    case "integer":
      return (
        // The default rides in the placeholder rather than the hint: a 12rem
        // field cannot afford "description — blank = N" on one line.
        <Field label={field.label} hint={hint} className="max-w-[16rem]">
          <TextInput
            inputMode={field.kind === "integer" ? "numeric" : "decimal"}
            value={value === undefined || value === null ? "" : String(value)}
            placeholder={field.default !== undefined ? String(field.default) : undefined}
            min={field.minimum}
            max={field.maximum}
            onChange={(e) => onChange(coerceNumber(field.kind as "number" | "integer", e.target.value))}
          />
        </Field>
      );
    default:
      return (
        <Field label={field.label} hint={hint}>
          {field.multiline ? (
            <TextArea
              value={typeof value === "string" ? value : ""}
              placeholder={typeof field.default === "string" ? field.default : undefined}
              onChange={(e) => onChange(e.target.value || undefined)}
            />
          ) : (
            <TextInput
              value={typeof value === "string" ? value : ""}
              placeholder={typeof field.default === "string" ? field.default : undefined}
              onChange={(e) => onChange(e.target.value || undefined)}
            />
          )}
        </Field>
      );
  }
}
