/**
 * AppSettingsView — app-wide preferences, one section at a time.
 *
 * This was a 480px modal with a single scrolling column, and it had grown to
 * cover theme, authentication, model defaults, transcript filtering, token
 * limits, notification webhooks, the update channel and a button that stops the
 * server. Nothing connected any two of those except their scroll positions, and
 * the only way to reach the last one was to scroll past all the others.
 *
 * Now it's a page with a rail (see SettingsShell for the responsive behaviour)
 * and a registry (see appSections). Loading, the draft and the single Save stay
 * exactly where they were — only the layout changed. The draft itself lives in
 * a store rather than in this component, because a page can be navigated away
 * from at any moment and half-typed settings should not be the price (see
 * stores/settingsDraft).
 *
 * Only the settings the server actually stores are exposed (see
 * AppSettingsSchema); saving merges + revalidates server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { SlidersHorizontal, Save, Undo2 } from "lucide-react";
import { SHELL_TRANSCRIPT_CATEGORIES } from "@dispatch/shared";
import type { HarnessKind, ModelOption } from "@dispatch/shared";
import { InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { api, type AppSettings, type HarnessInfo } from "../../lib/api.js";
import { useNotices } from "../../stores/notices.js";
import { useSettings } from "../../stores/settings.js";
import { useTheme } from "../../stores/theme.js";
import { useView, type AppSettingsSection } from "../../stores/view.js";
import { useAppSettingsDraft, appSettingsDirty } from "../../stores/settingsDraft.js";
import { SettingsShell } from "./SettingsShell.js";
import { APP_SECTIONS, APP_SECTION_BY_ID } from "./appSections.js";
import { AppearanceSection } from "./sections/AppearanceSection.js";
import { ChatSection } from "./sections/ChatSection.js";
import { ContextSection, normalizeContextLimits } from "./sections/ContextSection.js";
import { NotificationsSection } from "./sections/NotificationsSection.js";
import { AuthSettings } from "../auth/AuthSettings.js";
import { UpdateBanner } from "../update/UpdateBanner.js";
import { StopDispatch } from "./StopDispatch.js";

/**
 * The server's response, filled out to the shape every section edits.
 *
 * Both the baseline and the draft go through this, which is what makes "did
 * anything change?" an honest question — without it, a section rendering its
 * effective default would read as an edit the moment you opened it.
 */
function normalize(s: AppSettings): AppSettings {
  return {
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
}

/** The sections whose edits go through the save bar. */
const SERVER_BACKED = new Set<AppSettingsSection>([
  "appearance",
  "chat",
  "context",
  "notifications",
]);

export function AppSettingsView() {
  const section = useView((s) => s.appSection);
  const setSection = useView((s) => s.setAppSection);
  const pushToast = useNotices((s) => s.push);
  const setTheme = useTheme((s) => s.setTheme);

  const saved = useAppSettingsDraft((s) => s.saved);
  const draft = useAppSettingsDraft((s) => s.draft);
  const patch = useAppSettingsDraft((s) => s.patch);
  const dirty = useAppSettingsDraft(appSettingsDirty);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessKind, ModelOption[]>>>({});

  // Load once. A draft already in the store means unsaved edits from an earlier
  // visit, and refetching would silently throw them away — the exact failure
  // hoisting the draft out of this component existed to prevent.
  const hasDraft = draft !== null;
  useEffect(() => {
    if (hasDraft) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.settings
      .get()
      .then((s) => {
        if (cancelled) return;
        const next = normalize(s);
        useAppSettingsDraft.getState().hydrate(next);
        // The server value is the cross-device truth; localStorage only ever
        // held a pre-paint cache of it, so reconcile toward the server on load.
        setTheme(next.theme);
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
  }, [hasDraft, setTheme]);

  // Catalogs are cheap and can change under us (a provider installed since the
  // last visit), so unlike the draft they refresh on every mount.
  useEffect(() => {
    void api.harnesses.list().then(setHarnesses).catch(() => setHarnesses([]));
    for (const kind of ["claude", "codex"] as const) {
      void api.models
        .list(kind)
        .then((models) => setCatalogs((current) => ({ ...current, [kind]: models })))
        .catch(() => {});
    }
  }, []);

  const discard = useCallback(() => {
    useAppSettingsDraft.getState().discard();
    // The theme picker previews live, so dropping the draft has to un-paint it.
    const base = useAppSettingsDraft.getState().saved;
    if (base) setTheme(base.theme);
  }, [setTheme]);

  const save = useCallback(async () => {
    if (busy || !draft) return;
    setBusy(true);
    setError(null);
    const body: AppSettings = {
      ...draft,
      defaultModeId: draft.defaultModeId || undefined,
      webhook: { ...draft.webhook, url: draft.webhook?.url?.trim() || undefined },
      autoCompact: { ...draft.autoCompact, window: draft.autoCompact?.window || undefined },
      harness: {
        ...draft.harness,
        defaultHarness: draft.harness?.defaultHarness ?? "claude",
        defaults: draft.harness?.defaults ?? {},
        contextLimits: normalizeContextLimits(draft.harness?.contextLimits ?? {}),
      },
    };
    try {
      const result = await api.settings.update(body);
      const next = normalize(result);
      useAppSettingsDraft.getState().commit(next);
      setTheme(next.theme);
      // Push into the live store too: transcripts read this on every render and
      // would otherwise keep the boot-time value until a reload.
      useSettings.getState().apply(result);
      pushToast({ level: "info", text: "Settings saved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, pushToast, setTheme]);

  const def = APP_SECTION_BY_ID.get(section) ?? APP_SECTIONS[0]!;
  const Icon = def.icon;
  const paneProps = draft ? { draft, patch, harnesses, catalogs } : null;

  return (
    <SettingsShell<AppSettingsSection>
      icon={<SlidersHorizontal />}
      title="Settings"
      subtitle="App-wide preferences, persisted server-side"
      sections={APP_SECTIONS.map((s) => ({
        id: s.id,
        icon: s.icon,
        label: s.label,
        blurb: s.blurb,
        // Only the four server-backed sections can be dirty; auth, updates and
        // system all act immediately and have nothing to save.
        dirty: dirty && SERVER_BACKED.has(s.id),
      }))}
      active={section}
      onSelect={setSection}
      footer={
        error || dirty ? (
          <>
            {error ? (
              <div className="mr-auto min-w-0 flex-1">
                <InlineError message={error} />
              </div>
            ) : (
              <span className="mr-auto truncate text-2xs font-medium text-warn">
                Unsaved changes
              </span>
            )}
            {dirty && (
              <>
                <Button variant="ghost" leftIcon={<Undo2 />} disabled={busy} onClick={discard}>
                  Discard
                </Button>
                <Button
                  variant="primary"
                  leftIcon={busy ? <Spinner size={12} /> : <Save />}
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </>
            )}
          </>
        ) : null
      }
    >
      <div className="space-y-3">
        <div>
          <div className="flex items-center gap-2 [&_svg]:size-4">
            <Icon className="shrink-0 text-accent" />
            <h3 className="text-base font-semibold text-primary">{def.label}</h3>
          </div>
          {def.explainer && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{def.explainer}</p>
          )}
        </div>

        {loading && !draft ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner size={14} /> Loading settings…
          </div>
        ) : section === "auth" ? (
          <AuthSettings />
        ) : section === "updates" ? (
          <UpdateBanner />
        ) : section === "system" ? (
          <StopDispatch />
        ) : !paneProps ? (
          <InlineError message={error ?? "Settings could not be loaded."} />
        ) : section === "appearance" ? (
          <AppearanceSection {...paneProps} />
        ) : section === "chat" ? (
          <ChatSection {...paneProps} />
        ) : section === "context" ? (
          <ContextSection {...paneProps} />
        ) : (
          <NotificationsSection {...paneProps} />
        )}
      </div>
    </SettingsShell>
  );
}
