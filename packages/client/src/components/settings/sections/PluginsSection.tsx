import { useCallback, useEffect, useState } from "react";
import { Copy, FolderOpen, RefreshCw, Save } from "lucide-react";
import type { PluginInfo, PluginStatus } from "@dispatch/shared";
import { Field, InlineError, TextArea, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Chip } from "../../ui/Chip.js";
import { Select } from "../../ui/Select.js";
import { Spinner } from "../../ui/Spinner.js";
import { StatusDot, type DotTone } from "../../ui/StatusDot.js";
import { Switch } from "../../ui/Switch.js";
import { api } from "../../../lib/api.js";
import { useCopyId } from "../../../lib/useCopyId.js";
import { useNotices } from "../../../stores/notices.js";
import { coerceNumber, displayValue, fieldsFromSchema, type SettingsField } from "./pluginSettingsForm.js";

/**
 * Settings → Plugins: every directory under `<configDir>/plugins/`, with the
 * host's verdict on each.
 *
 * Saves through its own routes on every change rather than through the
 * settings draft, like Permissions does, because the toggle and a plugin's
 * settings are owned by `PUT /api/plugins/:id/*` — targeted patches a plugin
 * can observe live (`ctx.settings.onChange`). A draft would hand the plugin a
 * stale copy the next time anyone saved a theme.
 */
export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.plugins
      .list()
      .then(setPlugins)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const replace = (next: PluginInfo) =>
    setPlugins((rows) => rows?.map((p) => (p.id === next.id ? next : p)) ?? rows);

  if (plugins === null && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <InlineError message={error} />
      {plugins && plugins.length === 0 ? (
        <div className="rounded-md border border-line-soft px-3 py-4 text-xs leading-relaxed text-muted">
          <p className="font-medium text-secondary">No plugins installed.</p>
          <p className="mt-1">
            Drop one into <code className="text-fg">plugins/&lt;id&gt;/</code> under Dispatch&apos;s config
            directory, or run <code className="text-fg">cm plugin add &lt;path&gt;</code>, then restart.
          </p>
        </div>
      ) : (
        plugins?.map((p) => <PluginCard key={p.id} plugin={p} onChange={replace} />)
      )}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw />} onClick={load}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ card */

const STATUS: Record<PluginStatus, { tone: DotTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  disabled: { tone: "muted", label: "Off" },
  error: { tone: "danger", label: "Failed to start" },
  invalid: { tone: "danger", label: "Invalid manifest" },
  incompatible: { tone: "warn", label: "Incompatible" },
};

function PluginCard({ plugin, onChange }: { plugin: PluginInfo; onChange: (next: PluginInfo) => void }) {
  const pushToast = useNotices((s) => s.push);
  const copy = useCopyId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[plugin.status];
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
      {plugin.needsRestart && (
        <p className="text-xs text-warn">
          Enabled — restart Dispatch to load it. Plugins are not hot-reloaded.
        </p>
      )}
      <InlineError message={error} />

      <div className="flex flex-wrap items-center gap-1">
        <Chip mono tone="muted">
          {plugin.id}
        </Chip>
        {plugin.capabilities.map((c) => (
          <Chip key={c} tone="accent">
            {c}
          </Chip>
        ))}
        {plugin.secrets?.map((s) => (
          <Chip key={s} tone="warn" mono>
            secret:{s}
          </Chip>
        ))}
        {plugin.capabilities.length === 0 && !plugin.secrets?.length && (
          <span className="text-2xs text-faint">declares no capabilities</span>
        )}
      </div>

      {plugin.settingsSchema !== undefined && plugin.status !== "invalid" && (
        <PluginSettingsForm plugin={plugin} onChange={onChange} />
      )}

      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate cm-mono text-2xs text-faint" title={plugin.dir}>
          {plugin.dir}
        </code>
        <IconButton tip="Copy path" onClick={() => copy(plugin.dir, "Plugin path")}>
          <Copy />
        </IconButton>
        <Button variant="ghost" size="sm" leftIcon={<FolderOpen />} onClick={() => void reveal()}>
          Open folder
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ form */

/**
 * The generic settings form. Local edits, one Save: a plugin's `onChange`
 * fires per save, and a plugin that reconnects to a service on every
 * keystroke of its URL field is nobody's idea of a good time.
 */
function PluginSettingsForm({ plugin, onChange }: { plugin: PluginInfo; onChange: (next: PluginInfo) => void }) {
  const { fields, unsupported } = fieldsFromSchema(plugin.settingsSchema);
  const [draft, setDraft] = useState<Record<string, unknown>>(plugin.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save that lands replaces `plugin.settings`; re-seed so the form shows
  // what was actually stored (the server may have normalised it).
  useEffect(() => setDraft(plugin.settings), [plugin.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(plugin.settings);

  const set = (key: string, value: unknown) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A half-typed number is still a string in the draft; it does not get saved as one.
      const clean = Object.fromEntries(
        Object.entries(draft).filter(([k, v]) => {
          const f = fields.find((x) => x.key === k);
          return !(f && (f.kind === "number" || f.kind === "integer") && typeof v === "string");
        }),
      );
      onChange(await api.plugins.setSettings(plugin.id, clean));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!fields.length && !unsupported.length) return null;

  return (
    <div className="space-y-2 rounded-md bg-inset/40 px-2.5 py-2">
      {fields.map((f) => (
        <FieldControl key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      {unsupported.length > 0 && (
        <p className="text-2xs text-faint">
          Not editable here ({unsupported.join(", ")}) — set them under <code>plugins.{plugin.id}.settings</code> in
          config.json.
        </p>
      )}
      <InlineError message={error} />
      {dirty && (
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(plugin.settings)}>
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
