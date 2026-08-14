/**
 * App Settings modal — the gear in the top bar opens this. Loads the live
 * config via `GET /api/settings`, edits a local draft, and persists via
 * `PUT /api/settings`. Only the settings the server actually stores are exposed
 * (theme, default mode, notification webhook — see AppSettingsSchema); saving
 * merges + revalidates server-side. Theme applies to the document on save so the
 * change is reflected immediately (and re-reflected whenever the modal loads).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal, Moon, Sun, Monitor, Bell, Layers, Cpu } from "lucide-react";
import { Modal, Field, TextInput, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { SectionLabel } from "../ui/Panel.js";
import { api, type AppSettings, type HarnessInfo } from "../../lib/api.js";
import type { Effort, HarnessKind, ModelOption } from "@dispatch/shared";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { useProjects } from "../../stores/projects.js";
import { useNotices } from "../../stores/notices.js";
import { useSettings } from "../../stores/settings.js";
import { useTheme, type ThemePref } from "../../stores/theme.js";
import { useOverlay } from "../../stores/view.js";
import { useBrowserNotify, notifyUnavailableReason } from "../../lib/browserNotify.js";
import { StopDispatch } from "./StopDispatch.js";
import { cn } from "../../lib/cn.js";
import { positiveTokenLimit } from "../../lib/harness.js";
import { SHELL_TRANSCRIPT_CATEGORIES } from "@dispatch/shared";
import { ShellFilterPanel } from "../chat/ShellFilterPanel.js";
import { AuthSettings } from "../auth/AuthSettings.js";

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
      className="flex items-center gap-2 text-sm font-medium text-secondary"
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

/**
 * Desktop notifications — the only control in this modal that is NOT saved
 * server-side, and deliberately so. The browser permission it depends on is
 * granted per origin per browser, so "on" can only ever mean "on in this
 * browser"; persisting it centrally would promise every device something one
 * device granted. Everything here lives in localStorage (see lib/browserNotify).
 */
function DesktopNotifications() {
  const enabled = useBrowserNotify((s) => s.enabled);
  const permission = useBrowserNotify((s) => s.permission);
  const setEnabled = useBrowserNotify((s) => s.setEnabled);
  const request = useBrowserNotify((s) => s.request);
  const unavailable = notifyUnavailableReason();

  return (
    <div className="mb-3 rounded-md border border-line bg-inset/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-secondary">Desktop notifications</span>
        {unavailable || permission === "unsupported" ? null : permission === "granted" ? (
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label={enabled ? "On" : "Muted"}
          />
        ) : permission === "denied" ? (
          <span className="text-xs text-warn">Blocked</span>
        ) : (
          <Button size="sm" onClick={() => void request()}>
            Enable
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs leading-snug text-faint">
        {unavailable ??
          (permission === "denied"
            ? "You blocked notifications for this origin — re-allow them in the browser's site settings, then reopen this panel."
            : "An OS toast when an agent needs a decision, a question answered, or finishes — only while the app isn't focused. Clicking one jumps to the chat.")}
      </p>
    </div>
  );
}

const DEFAULT_DRAFT: AppSettings = {
  theme: "dark",
  webhook: { enabled: false },
  harness: { defaultHarness: "claude", defaults: {} },
  shellFilter: [...SHELL_TRANSCRIPT_CATEGORIES],
};

export function SettingsPanel() {
  const { open, close: onClose } = useOverlay("settings");
  const modes = useProjects((s) => s.modes);
  const pushToast = useNotices((s) => s.push);
  const setTheme = useTheme((s) => s.setTheme);

  const [draft, setDraft] = useState<AppSettings>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessKind, ModelOption[]>>>({});
  // What the theme was when the modal opened, so cancelling can put it back —
  // the picker applies LIVE (you cannot judge a palette from a word), which
  // means abandoning the dialog would otherwise leave the app repainted.
  const themeOnOpen = useRef<ThemePref>("dark");

  // (Re)load the live settings each time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    themeOnOpen.current = useTheme.getState().pref;
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
          autoCompact: {
            enabled: s.autoCompact?.enabled ?? true,
            window: s.autoCompact?.window,
          },
          showInjectedContext: s.showInjectedContext ?? false,
          shellFilter: s.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES],
          spawnChat: { autoApprove: s.spawnChat?.autoApprove ?? false },
          harness: {
            defaultHarness: s.harness?.defaultHarness ?? "claude",
            defaults: s.harness?.defaults ?? {},
            contextLimits: s.harness?.contextLimits ?? {},
          },
        };
        setDraft(next);
        // The server value is the cross-device truth; localStorage only ever
        // held a pre-paint cache of it, so reconcile toward the server on load.
        themeOnOpen.current = next.theme;
        setTheme(next.theme);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void api.harnesses.list().then(setHarnesses).catch(() => setHarnesses([]));
    for (const kind of ["claude", "codex"] as const) {
      void api.models
        .list(kind)
        .then((models) => setCatalogs((current) => ({ ...current, [kind]: models })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [open]);

  const patch = useCallback((p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p })), []);
  // Every exit that isn't "Save" (Cancel, Esc, backdrop) undoes the live preview.
  const cancel = useCallback(() => {
    setTheme(themeOnOpen.current);
    onClose();
  }, [onClose, setTheme]);
  const patchWebhook = useCallback(
    (p: Partial<NonNullable<AppSettings["webhook"]>>) =>
      setDraft((d) => ({ ...d, webhook: { ...d.webhook, ...p } })),
    [],
  );
  const patchAutoCompact = useCallback(
    (p: Partial<NonNullable<AppSettings["autoCompact"]>>) =>
      setDraft((d) => ({ ...d, autoCompact: { ...d.autoCompact, ...p } })),
    [],
  );
  const patchHarness = useCallback(
    (p: Partial<NonNullable<AppSettings["harness"]>>) =>
      setDraft((d) => ({ ...d, harness: { ...d.harness, ...p } })),
    [],
  );
  const patchHarnessDefault = useCallback(
    (kind: HarnessKind, p: { model?: string; effort?: Effort }) =>
      setDraft((d) => ({
        ...d,
        harness: {
          ...d.harness,
          defaults: {
            ...d.harness?.defaults,
            [kind]: { ...d.harness?.defaults?.[kind], ...p },
          },
        },
      })),
    [],
  );
  const patchContextLimits = useCallback(
    (p: Partial<NonNullable<NonNullable<AppSettings["harness"]>["contextLimits"]>>) =>
      setDraft((d) => ({
        ...d,
        harness: {
          ...d.harness,
          contextLimits: { ...d.harness?.contextLimits, ...p },
        },
      })),
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
      autoCompact: {
        enabled: draft.autoCompact?.enabled ?? true,
        window: draft.autoCompact?.window || undefined,
      },
      showInjectedContext: draft.showInjectedContext ?? false,
      shellFilter: draft.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES],
      spawnChat: { autoApprove: draft.spawnChat?.autoApprove ?? false },
      harness: {
        defaultHarness: draft.harness?.defaultHarness ?? "claude",
        defaults: draft.harness?.defaults ?? {},
        contextLimits: {
          perChatTokens: positiveTokenLimit(draft.harness?.contextLimits?.perChatTokens),
          overallTokens: positiveTokenLimit(draft.harness?.contextLimits?.overallTokens),
        },
      },
    };
    try {
      const saved = await api.settings.update(body);
      setTheme(saved.theme ?? body.theme);
      // Push into the live store too: transcripts read this on every render and
      // would otherwise keep the boot-time value until a reload.
      useSettings.getState().apply(saved);
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
  const ac = draft.autoCompact ?? {};
  const harnessSettings = draft.harness ?? {};
  const harnessOptions: SelectOption<HarnessKind>[] = (["claude", "codex"] as const).map(
    (kind) => {
      const runtime = harnesses.find((h) => h.kind === kind)?.runtime;
      return {
        value: kind,
        label: kind === "claude" ? "Claude Code" : "Codex",
        hint: runtime?.available ? runtime.version ?? runtime.source : "not installed",
      };
    },
  );

  return (
    <Modal
      open={open}
      onClose={cancel}
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
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || loading}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <AuthSettings />
        {/* appearance */}
        <div>
          <SectionLabel className="mb-1.5 px-0">Appearance</SectionLabel>
          <Field label="Theme" hint="previews live, saved for all devices">
            <SegmentedControl
              size="md"
              value={draft.theme}
              onChange={(v) => {
                patch({ theme: v });
                setTheme(v);
              }}
              segments={[
                { value: "dark", label: "Dark", icon: <Moon /> },
                { value: "light", label: "Light", icon: <Sun /> },
                { value: "system", label: "System", icon: <Monitor /> },
              ]}
            />
          </Field>
        </div>

        {/* defaults */}
        <div>
          <SectionLabel className="mb-1.5 px-0">Defaults</SectionLabel>
          <Field label="Default provider" hint="new projects and chats inherit this">
            <Select
              width={280}
              align="start"
              value={harnessSettings.defaultHarness ?? "claude"}
              onChange={(value) => patchHarness({ defaultHarness: value })}
              options={harnessOptions}
            />
          </Field>
          <Field label="Default mode" hint="new chats start here">
            <Select
              width={240}
              align="start"
              value={draft.defaultModeId ?? ""}
              onChange={(v) => patch({ defaultModeId: v || undefined })}
              options={modeOptions}
            />
          </Field>

          <div className="mt-3 space-y-2">
            {(["claude", "codex"] as const).map((kind) => {
              const defaults = harnessSettings.defaults?.[kind] ?? {};
              const efforts =
                harnesses.find((h) => h.kind === kind)?.capabilities.efforts ??
                EFFORT_OPTIONS.map((o) => o.value);
              const modelOptions: SelectOption<string>[] = [
                { value: "", label: "Provider default", hint: "unpinned" },
                ...(catalogs[kind] ?? []).map((m) => ({
                  value: m.value,
                  label: m.label,
                  hint: m.hint,
                })),
              ];
              return (
                <div key={kind} className="rounded-md border border-line bg-inset/40 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium capitalize text-secondary [&_svg]:size-3.5">
                    <Cpu /> {kind}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Model">
                      <Select
                        width={210}
                        className="w-full"
                        value={defaults.model ?? ""}
                        onChange={(model) => patchHarnessDefault(kind, { model: model || undefined })}
                        options={modelOptions}
                      />
                    </Field>
                    <Field label="Effort">
                      <Select
                        width={180}
                        className="w-full"
                        value={defaults.effort ?? "medium"}
                        onChange={(effort) => patchHarnessDefault(kind, { effort })}
                        options={EFFORT_OPTIONS.filter((o) => efforts.includes(o.value))}
                      />
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
          {/* The bottom of the chat → project → app → off chain. A project's
              `.dispatch/project.yaml` can override it for everyone working in
              that repo, and any single chat can override both. */}
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-secondary">Show sent context</div>
              <p className="mt-0.5 text-2xs leading-snug text-faint">
                Reveal what Dispatch attaches to your turns on your behalf — surfaced
                memories, repo snapshots. Rendering only; the agent receives it either way.
              </p>
            </div>
            <Switch
              checked={!!draft.showInjectedContext}
              onChange={(v) => patch({ showInjectedContext: v })}
              label={draft.showInjectedContext ? "Shown" : "Hidden"}
            />
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-secondary">Transcript shell</div>
            <p className="mb-2 text-2xs leading-snug text-faint">
              App-wide visibility defaults. Projects and chats inherit these until they set their own filter.
            </p>
            <ShellFilterPanel
              value={draft.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES]}
              inherited={[...SHELL_TRANSCRIPT_CATEGORIES]}
              onChange={(shellFilter) =>
                patch({ shellFilter: shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES] })
              }
            />
          </div>

          {/* The ONLY way past the spawn_chat consent prompt — the tool itself
              takes no bypass argument, so an agent can't turn this on for you.
              A project's `.dispatch/project.yaml` can override it per repo. */}
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-secondary">
                Auto-approve spawned chats
              </div>
              <p className="mt-0.5 text-2xs leading-snug text-faint">
                Agents can start new chats with <span className="font-mono">spawn_chat</span>.
                Off, every spawn waits on your approval; on, they start unattended.
              </p>
            </div>
            <Switch
              checked={!!draft.spawnChat?.autoApprove}
              onChange={(v) => patch({ spawnChat: { autoApprove: v } })}
              label={draft.spawnChat?.autoApprove ? "Automatic" : "Ask me"}
            />
          </div>
        </div>

        {/* notifications */}
        <div>
          <SectionLabel className="mb-1.5 px-0">
            <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
              <Bell /> Notifications
            </span>
          </SectionLabel>

          <DesktopNotifications />

          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel className="px-0">Webhook</SectionLabel>
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

        {/* context / auto-compaction */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel className="px-0">
              <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
                <Layers /> Context
              </span>
            </SectionLabel>
            <Switch
              checked={ac.enabled ?? true}
              onChange={(v) => patchAutoCompact({ enabled: v })}
              label={(ac.enabled ?? true) ? "Auto-compact on" : "Auto-compact off"}
            />
          </div>
          <p className="mb-2 text-xs text-faint">
            When a session's context window fills, summarize the conversation and continue
            automatically instead of erroring. Applies to new turns.
          </p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Field label="Per-chat limit" hint="tokens; blank = model limit">
              <TextInput
                mono
                inputMode="numeric"
                value={
                  harnessSettings.contextLimits?.perChatTokens != null
                    ? String(harnessSettings.contextLimits.perChatTokens)
                    : ""
                }
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d]/g, ""), 10);
                  patchContextLimits({ perChatTokens: Number.isFinite(n) ? n : undefined });
                }}
                placeholder="e.g. 180000"
              />
            </Field>
            <Field label="Overall limit" hint="active chats combined">
              <TextInput
                mono
                inputMode="numeric"
                value={
                  harnessSettings.contextLimits?.overallTokens != null
                    ? String(harnessSettings.contextLimits.overallTokens)
                    : ""
                }
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d]/g, ""), 10);
                  patchContextLimits({ overallTokens: Number.isFinite(n) ? n : undefined });
                }}
                placeholder="e.g. 600000"
              />
            </Field>
          </div>
          <div
            className={cn(
              "transition-opacity",
              !(ac.enabled ?? true) && "pointer-events-none opacity-45",
            )}
          >
            <Field label="Reserve window" hint="tokens; blank = SDK default">
              <TextInput
                mono
                inputMode="numeric"
                value={ac.window != null ? String(ac.window) : ""}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d]/g, ""), 10);
                  patchAutoCompact({ window: Number.isFinite(n) ? n : undefined });
                }}
                placeholder="e.g. 20000"
              />
            </Field>
          </div>
        </div>

        {/* stop the app — last, because it's the one control that ends the session */}
        <StopDispatch />
      </div>
    </Modal>
  );
}
