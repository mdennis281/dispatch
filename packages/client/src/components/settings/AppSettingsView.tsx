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
import { useCallback, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, Save, Undo2 } from "lucide-react";
import { SHELL_TRANSCRIPT_CATEGORIES } from "@dispatch/shared";
import type { HarnessKind, ModelOption } from "@dispatch/shared";
import { InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import {
  api,
  type AppSettings,
  type AppSettingsDefaults,
  type HarnessInfo,
} from "../../lib/api.js";
import { useNotices } from "../../stores/notices.js";
import { useSettings } from "../../stores/settings.js";
import { useView, type AppSettingsSection } from "../../stores/view.js";
import {
  useAppSettingsDraft,
  appSettingsDirty,
  dirtyAppSections,
} from "../../stores/settingsDraft.js";
import { SettingsShell } from "./SettingsShell.js";
import { APP_SECTIONS, APP_SECTION_BY_ID, pluginSectionDef, useAppSections } from "./appSections.js";
import { useSlots } from "../../plugins/slots.js";
import { PluginSlot } from "../../plugins/PluginSlot.js";
import { AppearanceSection } from "./sections/AppearanceSection.js";
import { AccountsSection } from "./sections/AccountsSection.js";
import { ChatSection } from "./sections/ChatSection.js";
import { ContextSection, normalizeContextLimits } from "./sections/ContextSection.js";
import { AgentContextSection } from "./sections/AgentContextSection.js";
import { RetentionSection } from "./sections/RetentionSection.js";
import { PermissionsSection } from "./sections/PermissionsSection.js";
import { NotificationsSection } from "./sections/NotificationsSection.js";
import { IntegrationsSection } from "./sections/IntegrationsSection.js";
import { PluginsSection } from "./sections/PluginsSection.js";
import { AuthSettings } from "../auth/AuthSettings.js";
import { UpdateBanner } from "../update/UpdateBanner.js";
import { StopDispatch } from "./StopDispatch.js";
import { RestartDispatch } from "./RestartDispatch.js";

/**
 * The server's response, filled out to the shape every section edits.
 *
 * Both the baseline and the draft go through this, which is what makes "did
 * anything change?" an honest question — without it, a section rendering its
 * effective default would read as an edit the moment you opened it.
 */
function normalize(s: AppSettings): AppSettings {
  return {
    // Vestigial: the theme is per browser now (stores/theme), but the server
    // schema still requires the field and PUT is a full replace, so it rides
    // through untouched. Nothing reads it back into the page.
    theme: s.theme ?? "dark",
    defaultModeId: s.defaultModeId,
    // Deliberately NOT filled in with an effective default like the fields
    // below: unset is a meaningful answer here ("whatever this server was
    // started with"), and the only honest number to substitute lives on the
    // server — which the field asks for separately (`/api/settings/defaults`)
    // and shows as a placeholder.
    maxActiveSessions: s.maxActiveSessions,
    idleSessionMinutes: s.idleSessionMinutes,
    webhook: {
      kind: s.webhook?.kind ?? "ntfy",
      url: s.webhook?.url ?? "",
      enabled: s.webhook?.enabled ?? false,
    },
    autoCompact: {
      enabled: s.autoCompact?.enabled ?? true,
      window: s.autoCompact?.window,
      perModel: s.autoCompact?.perModel ?? {},
      instructions: s.autoCompact?.instructions ?? "",
    },
    showInjectedContext: s.showInjectedContext ?? false,
    shellFilter: s.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES],
    // Carried RAW: unset means "no choice", and a field this function drops is
    // a field the next save of anything else DELETES (PUT is a full replace).
    terminalLocations: s.terminalLocations,
    spawnChat: { autoApprove: s.spawnChat?.autoApprove ?? false },
    // Both default TRUE — unset means fully enabled (see the schema). Spelling
    // the effective values out here is what keeps a save of some unrelated
    // preference from silently clearing them: PUT /api/settings is a full
    // replace, so a field missing from this draft is a field being turned off.
    worktreeCleanup: {
      enabled: s.worktreeCleanup?.enabled ?? true,
      deleteBranch: s.worktreeCleanup?.deleteBranch ?? true,
      graceMinutes: s.worktreeCleanup?.graceMinutes,
    },
    issueWatcher: { enabled: s.issueWatcher?.enabled ?? true },
    // Carried through RAW, unlike the blocks above — and that is the point.
    // `normalize` drops anything it does not name, and PUT /api/settings is a
    // full replace, so an omitted field is a field being deleted: saving a
    // theme would have wiped the round policy. Not spelled out to its effective
    // values either, because "unset" here means "inherit the shipped default",
    // and materialising that would pin every install to today's numbers the
    // first time anyone saved anything.
    reviewAgent: s.reviewAgent,
    // Carried RAW for the same reason as `reviewAgent` above: every field in it
    // means "inherit the shipped default" when unset, and materialising the
    // effective numbers here would pin this install to today's windows the first
    // time anyone saved a theme. Naming it at all is the load-bearing part — a
    // field this function omits is a field the next save DELETES.
    retention: s.retention,
    // Carried RAW, and this one is not even edited here: Settings → Plugins
    // writes through its own targeted routes. It is named so that saving a
    // theme from this draft does not delete every plugin's settings and
    // toggles — the server preserves it too, but a draft that round-trips the
    // field is honest about what it holds.
    plugins: s.plugins,
    // Spelled out for the reason above, and it matters doubly here: a field
    // this function drops is a field the section renders as "nothing muted"
    // whatever is stored, AND one the next save clears.
    attentionQueue: {
      kinds: s.attentionQueue?.kinds ?? {},
      reviewKinds: s.attentionQueue?.reviewKinds ?? {},
    },
    harness: {
      // As stored — absent stays absent. Filling Claude in here meant saving
      // ANY setting wrote `defaultHarness: "claude"` onto an install that might
      // not have Claude at all (#426).
      defaultHarness: s.harness?.defaultHarness,
      defaults: s.harness?.defaults ?? {},
      contextLimits: s.harness?.contextLimits ?? {},
    },
  };
}

export function AppSettingsView() {
  const section = useView((s) => s.appSection);
  const setSection = useView((s) => s.setAppSection);
  const pushToast = useNotices((s) => s.push);

  const saved = useAppSettingsDraft((s) => s.saved);
  const draft = useAppSettingsDraft((s) => s.draft);
  const patch = useAppSettingsDraft((s) => s.patch);
  const dirty = useAppSettingsDraft(appSettingsDirty);
  // Derived here rather than through a selector: `dirtyAppSections` builds a new
  // Set each call, and a selector that never returns a referentially-equal value
  // re-renders on every unrelated store write (and trips React's
  // "getSnapshot should be cached" guard).
  const dirtySections = useMemo(() => dirtyAppSections({ saved, draft }), [saved, draft]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [serverDefaults, setServerDefaults] = useState<AppSettingsDefaults | null>(null);
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
  }, [hasDraft]);

  // Catalogs are cheap and can change under us (a provider installed since the
  // last visit), so unlike the draft they refresh on every mount. The server's
  // own defaults ride along for the same reason — an env var moves when the
  // server restarts, and a field that names a stale one is worse than a blank.
  // Here rather than in the draft effect above, which is SKIPPED when a draft
  // already exists: unsaved edits must not cost the fields their placeholders.
  useEffect(() => {
    void api.settings.defaults().then(setServerDefaults).catch(() => setServerDefaults(null));
    void api.harnesses
      .list()
      .then((h) => {
        setHarnesses(h);
        for (const { kind } of h) {
          void api.models
            .list(kind)
            .then((models) => setCatalogs((current) => ({ ...current, [kind]: models })))
            .catch(() => {});
        }
      })
      .catch(() => setHarnesses([]));
  }, []);

  const discard = useCallback(() => {
    useAppSettingsDraft.getState().discard();
  }, []);

  const save = useCallback(async () => {
    if (busy || !draft) return;
    setBusy(true);
    setError(null);
    const body: AppSettings = {
      ...draft,
      defaultModeId: draft.defaultModeId || undefined,
      // `|| undefined` so a typed-then-deleted box (and a literal 0, which the
      // server rejects as not-positive) clears back to the default rather than
      // failing the save.
      maxActiveSessions: draft.maxActiveSessions || undefined,
      // `?? undefined`, not `|| undefined`: 0 is MEANINGFUL here (never retire),
      // and `||` would silently turn it back into "use the default".
      idleSessionMinutes: draft.idleSessionMinutes ?? undefined,
      webhook: { ...draft.webhook, url: draft.webhook?.url?.trim() || undefined },
      autoCompact: {
        ...draft.autoCompact,
        window: draft.autoCompact?.window || undefined,
        // An empty box is "no standing focus", not an empty string the broker
        // would dutifully send as `/compact `.
        instructions: draft.autoCompact?.instructions?.trim() || undefined,
      },
      harness: {
        ...draft.harness,
        defaultHarness: draft.harness?.defaultHarness || undefined,
        defaults: draft.harness?.defaults ?? {},
        contextLimits: normalizeContextLimits(draft.harness?.contextLimits ?? {}),
      },
    };
    try {
      const result = await api.settings.update(body);
      const next = normalize(result);
      useAppSettingsDraft.getState().commit(next);
      // Push into the live store too: transcripts read this on every render and
      // would otherwise keep the boot-time value until a reload.
      useSettings.getState().apply(result);
      pushToast({ level: "info", text: "Settings saved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, pushToast]);

  const sections = useAppSections();
  // A plugin's section (host.slots.settingsSection), when the selected id is
  // one. Rendered by the plugin; the heading and blurb are the host's.
  const pluginSection = useSlots((s) => s.settingsSections).find((e) => e.key === section);
  const def =
    APP_SECTION_BY_ID.get(section) ?? (pluginSection ? pluginSectionDef(pluginSection) : APP_SECTIONS[0]!);
  const Icon = def.icon;
  const paneProps = draft ? { draft, patch, harnesses, catalogs, serverDefaults } : null;

  return (
    <SettingsShell<AppSettingsSection>
      icon={<SlidersHorizontal />}
      title="Settings"
      subtitle="App-wide preferences, persisted server-side"
      sections={sections.map((s) => ({
        id: s.id,
        icon: s.icon,
        label: s.label,
        blurb: s.blurb,
        // Per section, so the dot points at what you actually edited. Auth,
        // accounts, plugins, updates and system never appear here — they save
        // through their own endpoints and have nothing in the draft.
        dirty: dirtySections.has(s.id),
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
        ) : pluginSection ? (
          <PluginSlot
            pluginId={pluginSection.pluginId}
            slot={`settingsSection ${pluginSection.def.id}`}
            render={pluginSection.def.render}
            args={[]}
          />
        ) : section === "auth" ? (
          <AuthSettings />
        ) : section === "integrations" ? (
          <IntegrationsSection />
        ) : section === "updates" ? (
          <UpdateBanner />
        ) : section === "system" ? (
          <div className="flex flex-col gap-4">
            <RestartDispatch />
            <StopDispatch />
          </div>
        ) : section === "accounts" ? (
          <AccountsSection />
        ) : section === "permissions" ? (
          <PermissionsSection />
        ) : section === "plugins" ? (
          <PluginsSection />
        ) : !paneProps ? (
          <InlineError message={error ?? "Settings could not be loaded."} />
        ) : section === "appearance" ? (
          <AppearanceSection {...paneProps} />
        ) : section === "chat" ? (
          <ChatSection {...paneProps} />
        ) : section === "context" ? (
          <ContextSection {...paneProps} />
        ) : section === "agent-context" ? (
          <AgentContextSection {...paneProps} />
        ) : section === "retention" ? (
          <RetentionSection {...paneProps} />
        ) : (
          <NotificationsSection {...paneProps} />
        )}
      </div>
    </SettingsShell>
  );
}
