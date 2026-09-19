import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CircleDot, Cpu, Gauge, MessageSquarePlus, RefreshCw, Save } from "lucide-react";
import {
  DEFAULT_ISSUE_CLAIM_LABEL,
  DEFAULT_ISSUE_TRUST,
  ISSUE_AUTHOR_TRUST,
  ISSUE_INTERVAL_MAX_MINUTES,
  ISSUE_INTERVAL_MIN_MINUTES,
  PROVIDER_IDS,
  issueSourceLabel,
  providerFor,
  resolveIssuePolicy,
  type Effort,
  type HarnessKind,
  type IssueAuthorTrust,
  type IssueClaim,
  type IssueConfig,
  type IssueMode,
  type IssueSource,
  type IssueWatch,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { relTime } from "../../lib/format.js";
import { harnessLabel } from "../../lib/harness.js";
import { useProviderCatalogs } from "../../lib/useProviderCatalogs.js";
import { selectChat } from "../../stores/navigation.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { OptionCard, ToggleRow } from "../ui/ToggleRow.js";

type SourceInfo = Awaited<ReturnType<typeof api.issues.source>>;
type Status = Awaited<ReturnType<typeof api.issues.status>>;
type ListedIssue = Awaited<ReturnType<typeof api.issues.open>>["issues"][number];

const CLAIM_TONE: Record<IssueClaim["state"], "info" | "accent" | "success" | "muted" | "danger"> = {
  claimed: "info",
  working: "accent",
  done: "success",
  released: "muted",
  failed: "danger",
};

/** Comma-separated list ⇄ array, for the label/login fields. */
const splitList = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const joinList = (xs: string[] | undefined): string => (xs ?? []).join(", ");

const inputClass = cn(
  "rounded-md border border-line bg-inset px-2 py-1 text-xs text-secondary",
  "placeholder:text-faint focus:border-accent-line focus:outline-none disabled:opacity-60",
);

/**
 * Project config → Issues. Enrols the project in issue-triggered chats and
 * says how: where its issues live (autofilled from `origin`, overridable),
 * which ones to take, what to do with them, and what the chat runs as. Also
 * the watcher's view of this project — the last poll, and every issue it has
 * claimed — because "it's on and nothing happened" is the first question
 * anyone configuring this asks, and the answer is nearly always a filter.
 *
 * Self-managing (its own Save), like Secrets: the block is a single decision
 * written whole, and batching it behind the page's Save alongside the workflow
 * would make "Save" mean two unrelated things.
 */
export function IssuesPane({ projectId, hasConfigDir }: { projectId: string; hasConfigDir: boolean }) {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState<ListedIssue[] | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [draft, setDraft] = useState<IssueConfig | null>(null);
  const [saved, setSaved] = useState<IssueConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The chat the last notice started, so "open chat" sits beside it. */
  const [startedChat, setStartedChat] = useState<string | null>(null);

  // The open list is read from the tracker itself, separately from the
  // watcher's status: a project with no source, or a tracker that is down,
  // must not take the whole pane with it — the config is still editable.
  const refreshOpen = useCallback(async () => {
    try {
      const r = await api.issues.open(projectId);
      setOpen(r.issues);
      setOpenError(null);
    } catch (err) {
      setOpen(null);
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      const [src, st] = await Promise.all([api.issues.source(projectId), api.issues.status(projectId)]);
      setSource(src);
      setStatus(st);
      setSaved(st.config);
      setDraft((d) => d ?? st.config ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    void refreshOpen();
  }, [projectId, refreshOpen]);

  useEffect(() => {
    setDraft(null);
    setLoading(true);
    void refresh();
  }, [refresh]);

  const dirty = JSON.stringify(draft ?? {}) !== JSON.stringify(saved ?? {});
  const policy = resolveIssuePolicy(draft);
  const patch = (p: Partial<IssueConfig>) => setDraft((d) => ({ ...(d ?? {}), ...p }));
  const patchFilters = (p: Partial<NonNullable<IssueConfig["filters"]>>) =>
    patch({ filters: { ...(draft?.filters ?? {}), ...p } });

  const save = async () => {
    setSaving(true);
    setNotice(null);
    setStartedChat(null);
    try {
      const block = draft && Object.keys(draft).length ? draft : null;
      await api.projectConfig.saveIssues(projectId, block);
      setNotice("Saved to project.yaml.");
      setDraft(block ?? {});
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pollNow = async () => {
    setPolling(true);
    setNotice(null);
    setStartedChat(null);
    try {
      const r = await api.issues.poll(projectId);
      setNotice(
        r.error
          ? `Poll failed: ${r.error}`
          : r.skipped === "baseline-set"
            ? "Enrolled. Issues opened from now on will be picked up."
            : r.skipped === "inactive"
              ? "This instance doesn't poll (dev checkout). The installed app will."
              : r.skipped === "disabled"
                ? "Nothing polled: the project isn't enabled, or the app switch is off."
                : r.taken.length
                  ? `Started a chat for ${r.taken.map((n) => `#${n}`).join(", ")}.`
                  : `Polled — nothing new to take (${r.seen.length} open issue${r.seen.length === 1 ? "" : "s"} seen).`,
      );
      if (r.chatId) setStartedChat(r.chatId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  };

  /** The human's pick: hand these issues to one chat, past every filter. */
  const take = async (numbers: number[]) => {
    setNotice(null);
    setStartedChat(null);
    try {
      const r = await api.issues.take(projectId, numbers);
      const refused = r.refused.map((x) => `#${x.number} (${x.reason})`).join(", ");
      setNotice(
        r.error && !r.taken.length
          ? `Could not start a chat: ${r.error}`
          : r.taken.length
            ? `Started a chat for ${r.taken.map((n) => `#${n}`).join(", ")}.${refused ? ` Skipped ${refused}.` : ""}`
            : `Nothing started${refused ? ` — ${refused}` : ""}.`,
      );
      if (r.chatId) setStartedChat(r.chatId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const { harnesses, catalogs } = useProviderCatalogs();
  const providerOptions = [
    { value: "", label: "Same as the project", hint: "follows it" },
    ...PROVIDER_IDS.map((kind) => {
      const runtime = harnesses.find((h) => h.kind === kind)?.runtime;
      return {
        value: kind,
        label: providerFor(kind).label,
        hint: !harnesses.length ? undefined : runtime?.available ? (runtime.version ?? runtime.source) : "not installed",
      };
    }),
  ];
  const catalog = draft?.harness ? (catalogs[draft.harness] ?? []) : [];
  const modelOptions = [
    { value: "", label: "Provider default", hint: "unpinned" },
    ...catalog.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
    ...(draft?.model && !catalog.some((m) => m.value === draft.model)
      ? [{ value: draft.model, label: draft.model, hint: "not in catalog" }]
      : []),
  ];

  const effective = source?.effective;
  const sourceOverridden = !!draft?.source;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 [&_svg]:size-4">
        <CircleDot className="shrink-0 text-accent" />
        <h3 className="text-base font-semibold text-primary">Issues</h3>
        {loading && <Spinner size={12} />}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={polling ? <Spinner size={12} /> : <RefreshCw />}
            onClick={() => void pollNow()}
            disabled={polling || loading || !policy.enabled || dirty}
            title={dirty ? "Save first — the poll reads the saved config" : "Read the tracker now, ignoring the interval"}
          >
            Poll now
          </Button>
          <Button
            variant="default"
            size="sm"
            leftIcon={saving ? <Spinner size={12} /> : <Save />}
            onClick={() => void save()}
            disabled={!dirty || saving || !hasConfigDir}
          >
            Save
          </Button>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        When an issue is opened in this project&rsquo;s tracker, Dispatch starts a chat to handle
        it — several at once share one chat, which delegates to child chats where that helps.
        Off until you turn it on here; the app-wide switch in Settings → Chat stops every project.
      </p>

      {!hasConfigDir && (
        <p className="flex items-start gap-1.5 text-2xs text-warn">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          This project has no config dir yet, so nothing here can be saved. Create one first.
        </p>
      )}
      {error && <p className="text-2xs text-danger">{error}</p>}
      {notice && (
        <p className="flex items-center gap-2 text-2xs text-secondary">
          {notice}
          {startedChat && (
            <Button variant="link" onClick={() => selectChat(startedChat)}>
              open chat
            </Button>
          )}
        </p>
      )}
      {status && !status.globalEnabled && (
        <p className="flex items-start gap-1.5 text-2xs text-warn">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          The app-wide switch (Settings → Chat → Issues) is off, so this project won&rsquo;t be polled.
        </p>
      )}
      {status && status.globalEnabled && !status.active && (
        <p className="text-2xs text-faint">
          This is a dev instance and doesn&rsquo;t poll — the installed app does. Settings saved here apply to both.
        </p>
      )}

      <ToggleRow
        checked={policy.enabled}
        onChange={(v) => patch({ enabled: v })}
        title="Handle new issues"
        icon={<CircleDot />}
        disabled={loading}
        description={
          <>
            Only issues opened <em>after</em> this is turned on are taken by the poll — the existing backlog
            stays yours, and you hand any of it over from the list below.
          </>
        }
      >
        <div className="space-y-3 pt-2">
          {/* ---- source */}
          <div className="rounded-md border border-line-soft px-3 py-2.5">
            <div className="text-xs font-medium text-secondary">Where the issues live</div>
            <p className="mt-0.5 text-2xs leading-snug text-faint">
              {effective
                ? effective.from === "origin"
                  ? <>From <span className="font-mono">origin</span>: {issueSourceLabel(effective.source)}</>
                  : <>Set here: {issueSourceLabel(effective.source)}</>
                : source?.remote
                  ? <>No provider recognises <span className="font-mono">{source.remote}</span> — set the source by hand.</>
                  : <>No <span className="font-mono">origin</span> remote — set the source by hand.</>}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="flex items-center gap-2 text-2xs text-faint">
                <input
                  type="checkbox"
                  checked={sourceOverridden}
                  onChange={(e) =>
                    patch({
                      source: e.target.checked
                        ? (source?.detected ?? { provider: "github", repo: "" })
                        : undefined,
                    })
                  }
                />
                Override
              </label>
              {sourceOverridden && (
                <>
                  <Select<IssueSource["provider"]>
                    options={[{ value: "github", label: "GitHub" }]}
                    value={draft!.source!.provider}
                    onChange={(v) => patch({ source: { ...draft!.source!, provider: v } })}
                    width={120}
                  />
                  <input
                    value={draft!.source!.host ?? ""}
                    onChange={(e) => patch({ source: { ...draft!.source!, host: e.target.value || undefined } })}
                    placeholder="github.com"
                    className={cn(inputClass, "w-40")}
                    title="Host — leave blank for github.com"
                  />
                  <input
                    value={draft!.source!.repo}
                    onChange={(e) => patch({ source: { ...draft!.source!, repo: e.target.value } })}
                    placeholder="owner/repo"
                    className={cn(inputClass, "w-48 font-mono")}
                  />
                </>
              )}
            </div>
          </div>

          {/* ---- mode */}
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["triage", "Triage", "Read, reproduce, label and comment. Never changes code."],
                ["implement", "Implement", "Clear bugs and small changes go to a PR with Fixes #n; the rest is triaged."],
              ] as Array<[IssueMode, string, string]>
            ).map(([mode, label, blurb]) => (
              <OptionCard
                key={mode}
                selected={policy.mode === mode}
                onSelect={() => patch({ mode })}
                label={label}
                blurb={blurb}
              />
            ))}
          </div>

          {/* ---- cadence + cap + label */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-2xs text-faint">
              Every
              <input
                type="number"
                min={ISSUE_INTERVAL_MIN_MINUTES}
                max={ISSUE_INTERVAL_MAX_MINUTES}
                value={draft?.intervalMinutes ?? ""}
                placeholder="60"
                onChange={(e) => patch({ intervalMinutes: e.target.value ? Number(e.target.value) : undefined })}
                className={cn(inputClass, "w-16")}
              />
              min
            </label>
            <label className="flex items-center gap-2 text-2xs text-faint">
              At most
              <input
                type="number"
                min={1}
                max={20}
                value={draft?.maxConcurrent ?? ""}
                placeholder="2"
                onChange={(e) => patch({ maxConcurrent: e.target.value ? Number(e.target.value) : undefined })}
                className={cn(inputClass, "w-14")}
              />
              in flight
            </label>
            <label className="flex items-center gap-2 text-2xs text-faint">
              Claim label
              <input
                value={draft?.claimLabel ?? ""}
                placeholder={DEFAULT_ISSUE_CLAIM_LABEL}
                onChange={(e) => patch({ claimLabel: e.target.value || undefined })}
                className={cn(inputClass, "w-36 font-mono")}
                title="Put on an issue while a chat works it — the lock every instance and human can see"
              />
            </label>
          </div>

          {/* ---- filters */}
          <div className="space-y-2 rounded-md border border-line-soft px-3 py-2.5">
            <div className="text-xs font-medium text-secondary">Which issues</div>
            <p className="text-2xs leading-snug text-faint">
              An issue&rsquo;s text becomes an agent&rsquo;s brief, so by default only people the repo
              already trusts get one. Every condition must pass.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ISSUE_AUTHOR_TRUST.map((t) => {
                const on = policy.filters.trust.includes(t);
                return (
                  <Button
                    key={t}
                    variant="toggle"
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? policy.filters.trust.filter((x) => x !== t) : [...policy.filters.trust, t];
                      patchFilters({ trust: next as IssueAuthorTrust[] });
                    }}
                    title={DEFAULT_ISSUE_TRUST.includes(t) ? "on by default" : "off by default"}
                  >
                    {t}
                  </Button>
                );
              })}
              <label className="ml-2 flex items-center gap-1.5 text-2xs text-faint">
                <input
                  type="checkbox"
                  checked={policy.filters.includeBots}
                  onChange={(e) => patchFilters({ includeBots: e.target.checked || undefined })}
                />
                include bots
              </label>
              <label className="flex items-center gap-1.5 text-2xs text-faint">
                <input
                  type="checkbox"
                  checked={!policy.filters.skipAssigned}
                  onChange={(e) => patchFilters({ skipAssigned: e.target.checked ? false : undefined })}
                />
                include assigned
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ListField label="Always these authors" value={draft?.filters?.authors} placeholder="login, login" onChange={(v) => patchFilters({ authors: v })} />
              <ListField label="Never these authors" value={draft?.filters?.excludeAuthors} placeholder="renovate[bot]" onChange={(v) => patchFilters({ excludeAuthors: v })} />
              <ListField label="Require one of these labels" value={draft?.filters?.labels} placeholder="agent, bug" onChange={(v) => patchFilters({ labels: v })} />
              <ListField label="Skip these labels" value={draft?.filters?.excludeLabels} placeholder="wontfix, question" onChange={(v) => patchFilters({ excludeLabels: v })} />
            </div>
            <label className="block text-2xs text-faint">
              Title must match
              <input
                value={draft?.filters?.titlePattern ?? ""}
                placeholder="regex, case-insensitive — optional"
                onChange={(e) => patchFilters({ titlePattern: e.target.value || undefined })}
                className={cn(inputClass, "mt-1 w-full font-mono")}
              />
            </label>
          </div>

          {/* ---- runs as */}
          <div className="space-y-2.5 rounded-md border border-line-soft px-3 py-2.5">
            <div className="text-xs font-medium text-secondary">The chat runs as</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2">
                <span className="text-2xs text-faint">Provider</span>
                <Select
                  options={providerOptions}
                  value={draft?.harness ?? ""}
                  onChange={(v) => {
                    const harness = (v || undefined) as HarnessKind | undefined;
                    if (harness === draft?.harness) return;
                    patch({ harness, model: undefined });
                  }}
                  leftIcon={<Cpu />}
                  width={220}
                />
              </label>
              {draft?.harness && (
                <label className="flex items-center gap-2">
                  <span className="text-2xs text-faint">Model</span>
                  <Select options={modelOptions} value={draft.model ?? ""} onChange={(v) => patch({ model: v || undefined })} width={220} />
                </label>
              )}
              <label className="flex items-center gap-2">
                <span className="text-2xs text-faint">Effort</span>
                <Select<Effort | "">
                  options={[{ value: "", label: "Task default", hint: "high" }, ...EFFORT_OPTIONS]}
                  value={draft?.effort ?? ""}
                  onChange={(v) => patch({ effort: (v || undefined) as Effort | undefined })}
                  leftIcon={<Gauge />}
                  width={160}
                />
              </label>
              <label className="flex items-center gap-2 text-2xs text-faint">
                Persona
                <input
                  value={draft?.personaId ?? ""}
                  placeholder="none"
                  onChange={(e) => patch({ personaId: e.target.value || undefined })}
                  className={cn(inputClass, "w-36")}
                />
              </label>
            </div>
            <div>
              <div className="text-2xs text-faint">House rules</div>
              <textarea
                value={draft?.instructions ?? ""}
                onChange={(e) => patch({ instructions: e.target.value || undefined })}
                rows={3}
                placeholder="e.g. anything touching billing gets triaged only, never implemented; link the CONTRIBUTING doc when asking for a repro"
                className={cn(
                  "mt-1 w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2",
                  "text-xs leading-relaxed text-secondary placeholder:text-faint",
                  "focus:border-accent-line focus:outline-none",
                )}
              />
            </div>
          </div>
        </div>
      </ToggleRow>

      <OpenIssues
        issues={open}
        error={openError}
        claimLabel={policy.claimLabel}
        onRefresh={refreshOpen}
        onTake={take}
      />

      {status && <WatchStatus watch={status.watch} claims={status.claims} />}
    </div>
  );
}

/**
 * The tracker's open issues, each with a Start chat — the backlog handed over
 * one issue (or a chosen few) at a time.
 *
 * Read live rather than from the last poll's memory because the poll never
 * runs on a dev instance and never runs at all until the project is enrolled,
 * and "point a chat at #42" is a thing worth doing in both of those states.
 * The reason column is what the WATCHER would say about the row; the button
 * ignores it on purpose, since a human choosing an issue is the authority
 * every filter defers to.
 */
function OpenIssues({
  issues,
  error,
  claimLabel,
  onRefresh,
  onTake,
}: {
  issues: ListedIssue[] | null;
  error: string | null;
  claimLabel: string;
  onRefresh: () => Promise<void>;
  onTake: (numbers: number[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  // Forget a selection the list no longer offers (taken, closed, gone).
  useEffect(() => {
    if (!issues) return;
    const present = new Set(issues.map((r) => r.issue.number));
    setSelected((s) => {
      const next = new Set([...s].filter((n) => present.has(n)));
      return next.size === s.size ? s : next;
    });
  }, [issues]);

  const inFlight = (r: ListedIssue) =>
    r.claim?.state === "claimed" || r.claim?.state === "working" || r.issue.labels.includes(claimLabel);
  const run = async (numbers: number[]) => {
    setBusy(new Set(numbers));
    try {
      await onTake(numbers);
      setSelected((s) => {
        const next = new Set(s);
        for (const n of numbers) next.delete(n);
        return next;
      });
    } finally {
      setBusy(new Set());
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const pickable = (issues ?? []).filter((r) => !inFlight(r));
  const allPicked = pickable.length > 0 && pickable.every((r) => selected.has(r.issue.number));
  const now = Date.now();

  return (
    <div className="space-y-2 border-t border-line-soft pt-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium text-secondary">
          Open issues
          {issues && <span className="ml-1.5 cm-mono !text-2xs text-faint">{issues.length}</span>}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {selected.size > 0 && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={busy.size ? <Spinner size={12} /> : <MessageSquarePlus />}
              onClick={() => void run([...selected])}
              disabled={busy.size > 0}
              title="One chat handles all of them together"
            >
              Start chat for {selected.size}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            leftIcon={refreshing ? <Spinner size={12} /> : <RefreshCw />}
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Re-read the tracker"
          >
            Refresh
          </Button>
        </div>
      </div>
      {error ? (
        <p className="flex items-start gap-1.5 text-2xs text-warn">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          {error}
        </p>
      ) : !issues ? (
        <p className="flex items-center gap-2 text-2xs text-faint">
          <Spinner size={10} /> Reading the tracker…
        </p>
      ) : issues.length === 0 ? (
        <p className="text-2xs text-faint">No open issues.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line-soft">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="border-b border-line-soft bg-inset/60 text-2xs uppercase tracking-wide text-faint">
                <th className="w-7 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select every issue a chat could take"
                    checked={allPicked}
                    disabled={pickable.length === 0}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(pickable.map((r) => r.issue.number)) : new Set())
                    }
                  />
                </th>
                <th className="w-14 px-1 py-1.5 text-left font-medium">#</th>
                <th className="px-1 py-1.5 text-left font-medium">Issue</th>
                <th className="hidden w-24 px-1 py-1.5 text-left font-medium md:table-cell">Opened</th>
                <th className="w-40 px-1 py-1.5 text-left font-medium">Watcher</th>
                <th className="w-28 px-2 py-1.5 text-right font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {issues.map((r) => {
                const n = r.issue.number;
                const held = inFlight(r);
                const running = busy.has(n);
                return (
                  <tr
                    key={n}
                    className={cn(
                      "border-b border-line-soft last:border-b-0 transition-colors hover:bg-hover/30",
                      selected.has(n) && "bg-accent-ghost/40",
                    )}
                  >
                    <td className="px-2 py-1.5 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select #${n}`}
                        checked={selected.has(n)}
                        disabled={held}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(n);
                            else next.delete(n);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-1 py-1.5 align-top">
                      <a href={r.issue.url} target="_blank" rel="noreferrer" className="cm-mono !text-xs text-accent-hi hover:underline">
                        #{n}
                      </a>
                    </td>
                    <td className="min-w-0 px-1 py-1.5 align-top">
                      <div className="truncate text-secondary" title={r.issue.title}>
                        {r.issue.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-faint">
                        <span>
                          @{r.issue.author}
                          <span className="opacity-70"> · {r.issue.authorTrust}</span>
                        </span>
                        {r.issue.labels.map((l) => (
                          <Chip key={l} tone={l === claimLabel ? "info" : "muted"}>
                            {l}
                          </Chip>
                        ))}
                        {r.issue.commentCount > 0 && (
                          <span>
                            · {r.issue.commentCount} comment{r.issue.commentCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-1 py-1.5 align-top text-2xs text-faint md:table-cell" title={r.issue.createdAt}>
                      {relTime(Date.parse(r.issue.createdAt), now)}
                    </td>
                    <td className="px-1 py-1.5 align-top">
                      {r.claim ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <Chip tone={CLAIM_TONE[r.claim.state]}>{r.claim.state}</Chip>
                          {r.claim.chatId && (
                            <Button variant="link" onClick={() => selectChat(r.claim!.chatId!)}>
                              open chat
                            </Button>
                          )}
                        </span>
                      ) : (
                        <span className={cn("block truncate text-2xs", r.reason ? "text-faint" : "text-success")} title={r.reason}>
                          {r.reason ?? "would take"}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right align-top">
                      {!held && (
                        <Button
                          variant="subtle"
                          size="sm"
                          leftIcon={running ? <Spinner size={12} /> : <MessageSquarePlus />}
                          onClick={() => void run([n])}
                          disabled={busy.size > 0}
                          title={r.claim ? `Start a fresh chat — the last one is ${r.claim.state}` : "Start a chat for this issue"}
                        >
                          {r.claim ? "Again" : "Start chat"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ListField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  placeholder: string;
  onChange: (v: string[] | undefined) => void;
}) {
  // Local text so a trailing comma survives typing; parsed on blur.
  const [text, setText] = useState(joinList(value));
  useEffect(() => setText(joinList(value)), [value]);
  return (
    <label className="block text-2xs text-faint">
      {label}
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const xs = splitList(text);
          onChange(xs.length ? xs : undefined);
        }}
        className={cn(inputClass, "mt-1 w-full")}
      />
    </label>
  );
}

/** The last poll and every claim this instance has made. */
function WatchStatus({ watch, claims }: { watch: IssueWatch | null; claims: IssueClaim[] }) {
  if (!watch) {
    return <p className="text-2xs text-faint">Not enrolled yet — save with it on, and the first poll marks the starting point.</p>;
  }
  return (
    <div className="space-y-2 border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
        <span>Enrolled {relTime(watch.baselineAt)}</span>
        {watch.lastPolledAt && <span>· last poll {relTime(watch.lastPolledAt)}</span>}
        {watch.lastError && (
          <span className="flex items-center gap-1 text-warn">
            <AlertTriangle className="size-3" /> {watch.lastError}
          </span>
        )}
      </div>
      {claims.length > 0 && (
        <div>
          <div className="mb-1 text-2xs font-medium text-secondary">Claimed by this instance</div>
          <ul className="space-y-0.5">
            {claims.map((c) => (
              <li key={c.key} className="flex items-baseline gap-2 text-2xs">
                <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-accent-hi hover:underline">
                  #{c.number}
                </a>
                <span className="min-w-0 truncate text-secondary">{c.title}</span>
                <Chip tone={CLAIM_TONE[c.state]} className="ml-auto shrink-0">
                  {c.state}
                </Chip>
                {c.chatId && (
                  <Button variant="link" onClick={() => selectChat(c.chatId!)} className="shrink-0">
                    open chat
                  </Button>
                )}
                {c.note && <span className="shrink-0 text-faint" title={c.note}>·</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
