/**
 * App Settings modal — the gear in the top bar opens this. Loads the live
 * config via `GET /api/settings`, edits a local draft, and persists via
 * `PUT /api/settings`. Only the settings the server actually stores are exposed
 * (theme, default mode, notification webhook — see AppSettingsSchema); saving
 * merges + revalidates server-side. Theme applies to the document on save so the
 * change is reflected immediately (and re-reflected whenever the modal loads).
 */
import { useCallback, useEffect, useState } from "react";
import { SlidersHorizontal, Moon, Sun, Bell } from "lucide-react";
import { Modal, Field, TextInput, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { SectionLabel } from "../ui/Panel.js";
import { api, type AppSettings } from "../../lib/api.js";
import { useProjects } from "../../stores/projects.js";
import { useNotices } from "../../stores/notices.js";
import { cn } from "../../lib/cn.js";

/** Apply the persisted theme to the document (mirrors index.html `class="dark"`). */
function applyTheme(theme: AppSettings["theme"]): void {
  document.documentElement.classList.toggle("dark", theme !== "light");
  document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
}

/** A compact token-styled on/off switch (no primitive exists yet). */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[12px] font-medium text-secondary"
    >
      <span
        className={cn(
          "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent-line bg-accent-dim/80" : "border-line bg-inset",
        )}
      >
        <span
          className={cn(
            "absolute size-3 rounded-full bg-primary shadow transition-transform",
            checked ? "translate-x-[14px]" : "translate-x-[3px]",
          )}
        />
      </span>
      {label}
    </button>
  );
}

const DEFAULT_DRAFT: AppSettings = { theme: "dark", webhook: { enabled: false } };

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const modes = useProjects((s) => s.modes);
  const pushToast = useNotices((s) => s.push);

  const [draft, setDraft] = useState<AppSettings>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)load the live settings each time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.settings
      .get()
      .then((s) => {
        if (cancelled) return;
        const next: AppSettings = {
          theme: s.theme ?? "dark",
          defaultModeId: s.defaultModeId,
          webhook: {
            kind: s.webhook?.kind ?? "ntfy",
            url: s.webhook?.url ?? "",
            enabled: s.webhook?.enabled ?? false,
          },
        };
        setDraft(next);
        applyTheme(next.theme);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const patch = useCallback((p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p })), []);
  const patchWebhook = useCallback(
    (p: Partial<NonNullable<AppSettings["webhook"]>>) =>
      setDraft((d) => ({ ...d, webhook: { ...d.webhook, ...p } })),
    [],
  );

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const body: AppSettings = {
      theme: draft.theme,
      defaultModeId: draft.defaultModeId || undefined,
      webhook: {
        kind: draft.webhook?.kind ?? "ntfy",
        url: draft.webhook?.url?.trim() || undefined,
        enabled: draft.webhook?.enabled ?? false,
      },
    };
    try {
      const saved = await api.settings.update(body);
      applyTheme(saved.theme ?? body.theme);
      pushToast({ level: "info", text: "Settings saved" });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const modeOptions: SelectOption<string>[] = [
    { value: "", label: "None (SDK default)", hint: "no fixed mode" },
    ...modes.map((m) => ({ value: m.id, label: m.name, hint: m.permissionMode })),
  ];

  const wh = draft.webhook ?? {};

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      icon={<SlidersHorizontal />}
      title="Settings"
      description="App-wide preferences (persisted server-side)."
      footer={
        <>
          {error && (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || loading}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* appearance */}
        <div>
          <SectionLabel className="mb-1.5 px-0">Appearance</SectionLabel>
          <Field label="Theme" hint="applies on save">
            <SegmentedControl
              size="md"
              value={draft.theme}
              onChange={(v) => patch({ theme: v })}
              segments={[
                { value: "dark", label: "Dark", icon: <Moon /> },
                { value: "light", label: "Light", icon: <Sun /> },
              ]}
            />
          </Field>
        </div>

        {/* defaults */}
        <div>
          <SectionLabel className="mb-1.5 px-0">Defaults</SectionLabel>
          <Field label="Default mode" hint="new chats start here">
            <Select
              width={240}
              align="start"
              value={draft.defaultModeId ?? ""}
              onChange={(v) => patch({ defaultModeId: v || undefined })}
              options={modeOptions}
            />
          </Field>
        </div>

        {/* notifications */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel className="px-0">
              <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
                <Bell /> Notifications
              </span>
            </SectionLabel>
            <Switch
              checked={!!wh.enabled}
              onChange={(v) => patchWebhook({ enabled: v })}
              label={wh.enabled ? "Enabled" : "Disabled"}
            />
          </div>
          <div
            className={cn(
              "space-y-3 transition-opacity",
              !wh.enabled && "pointer-events-none opacity-45",
            )}
          >
            <Field label="Provider">
              <SegmentedControl
                size="md"
                value={wh.kind ?? "ntfy"}
                onChange={(v) => patchWebhook({ kind: v })}
                segments={[
                  { value: "ntfy", label: "ntfy" },
                  { value: "pushover", label: "Pushover" },
                ]}
              />
            </Field>
            <Field label="Webhook URL" hint="where push events POST">
              <TextInput
                mono
                value={wh.url ?? ""}
                onChange={(e) => patchWebhook({ url: e.target.value })}
                placeholder="https://ntfy.sh/your-topic"
              />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}
