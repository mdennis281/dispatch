import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CircleDot, Cpu, Gauge, RefreshCw, Save } from "lucide-react";
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
  const [draft, setDraft] = useState<IssueConfig | null>(null);
  const [saved, setSaved] = useState<IssueConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  }, [projectId]);

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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
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
      {notice && <p className="text-2xs text-secondary">{notice}</p>}
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
            Only issues opened <em>after</em> this is turned on are taken — the existing backlog stays yours.
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
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const next = on ? policy.filters.trust.filter((x) => x !== t) : [...policy.filters.trust, t];
                      patchFilters({ trust: next as IssueAuthorTrust[] });
                    }}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-2xs",
                      on ? "border-accent-line bg-accent-ghost text-accent-hi" : "border-line text-faint hover:text-secondary",
                    )}
                    title={DEFAULT_ISSUE_TRUST.includes(t) ? "on by default" : "off by default"}
                  >
                    {t}
                  </button>
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

      {status && <WatchStatus watch={status.watch} claims={status.claims} />}
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

/** The last poll and every claim — the "why didn't it pick that one up" answer. */
function WatchStatus({ watch, claims }: { watch: IssueWatch | null; claims: IssueClaim[] }) {
  if (!watch) {
    return <p className="text-2xs text-faint">Not enrolled yet — save with it on, and the first poll marks the starting point.</p>;
  }
  const seen = watch.lastSeen ?? [];
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
      {seen.length > 0 && (
        <div>
          <div className="mb-1 text-2xs font-medium text-secondary">Open at the last poll</div>
          <ul className="space-y-0.5">
            {seen.map((s) => (
              <li key={s.number} className="flex items-baseline gap-2 text-2xs">
                <a href={s.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-accent-hi hover:underline">
                  #{s.number}
                </a>
                <span className="min-w-0 truncate text-secondary">{s.title}</span>
                <span className={cn("ml-auto shrink-0", s.taken ? "text-success" : "text-faint")}>
                  {s.taken ? "taken" : s.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
                  <button type="button" onClick={() => selectChat(c.chatId!)} className="shrink-0 text-faint hover:text-secondary">
                    open chat
                  </button>
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
