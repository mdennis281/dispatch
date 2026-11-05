/**
 * Project config → Scheduled chats.
 *
 * Each schedule is a prompt the app launches as a FRESH chat on a cron, and the
 * file it lives in (`.dispatch/schedules/<id>.md`) is the source of truth — this
 * pane is a form over that file plus the runner's view of it: when it fires
 * next, what the last run was, and why a slot was passed over.
 *
 * The "why" lines are the reason the pane exists rather than a bare list. A
 * schedule runs while nobody is watching, so "it didn't run" is the question
 * anyone opening this has, and the answer is almost always one of the recorded
 * reasons (paused, the previous run was still going, the app was off with
 * catch-up disabled) or a launch error.
 *
 * Self-managing (its own Save per schedule), like Issues: each schedule is one
 * file written whole.
 *
 * Files that fail to load are NOT listed here: the page-level config banner
 * above every section already names them (scope `schedule`), and a second copy
 * in the pane read as two separate problems.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  Cpu,
  Gauge,
  Pause,
  Play,
  Plus,
  Save,
  SquarePen,
  Trash2,
  Zap,
} from "lucide-react";
import {
  checkCron,
  cronToPreset,
  describeCron,
  HOUR_STEPS,
  MINUTE_STEPS,
  nextFires,
  presetToCron,
  providerFor,
  providerIds,
  toAuthoredName,
  WEEKDAY_NAMES,
  type Effort,
  type HarnessKind,
  type Persona,
  type Schedule,
  type ScheduleInput,
  type SchedulePreset,
  type SchedulesResponse,
  type ScheduleView,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { relTime } from "../../lib/format.js";
import { useProviderCatalogs } from "../../lib/useProviderCatalogs.js";
import { selectChat } from "../../stores/navigation.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { ToggleRow } from "../ui/ToggleRow.js";

const inputClass = cn(
  "rounded-md border border-line bg-inset px-2 py-1 text-xs text-secondary",
  "placeholder:text-faint focus:border-accent-line focus:outline-none disabled:opacity-60",
);

/* ------------------------------------------------------------- formatting */

/** "in 5m" / "in 3h" / "in 2d" — `relTime` only reads the past. */
function untilTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 60) return "in under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/**
 * A wall-clock time in the schedule's OWN zone, zone named. The cron is read in
 * that zone, so showing its fires in the browser's would put "09:00" on a
 * schedule that says 9am somewhere else — and the zone label is what makes
 * either reading unambiguous.
 */
function wallClock(ts: number, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Date(ts).toLocaleString(undefined, { ...opts, timeZone });
  } catch {
    return new Date(ts).toLocaleString(undefined, opts);
  }
}

const STATUS_TONE: Record<string, "accent" | "info" | "success" | "danger" | "muted" | "warn"> = {
  running: "accent",
  waiting: "accent",
  queued: "info",
  "awaiting-input": "warn",
  done: "success",
  idle: "muted",
  failed: "danger",
  error: "danger",
};

/** The editable shape of a loaded schedule (the file name is derived, not authored). */
function toInput(s: Schedule): ScheduleInput {
  const { file: _file, ...rest } = s;
  return rest;
}

/* ------------------------------------------------------------------- pane */

type Editing = { mode: "new" } | { mode: "edit"; schedule: Schedule };

export function SchedulesPane({ projectId }: { projectId: string }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; chatId?: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.schedules.list(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setData(null);
    setEditing(null);
    setNotice(null);
    setLoading(true);
    void refresh();
    void api.personas
      .list(projectId)
      .then(setPersonas)
      .catch(() => setPersonas([]));
    // Next-run and "last run" are read off the server's clock; a pane left open
    // across a fire would otherwise show a stale "in 2m" forever.
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [projectId, refresh]);

  /** Run an action against one schedule, with its row's spinner and the pane's error line. */
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runNow = (s: Schedule) =>
    act(s.id, async () => {
      const { chatId } = await api.schedules.run(projectId, s.id);
      setNotice({ text: `Started a run of “${s.name}”.`, chatId });
      await refresh();
    });
  const toggle = (s: Schedule) =>
    act(s.id, async () => setData(await api.schedules.save(projectId, { ...toInput(s), enabled: !s.enabled })));
  const remove = (s: Schedule) =>
    act(s.id, async () => {
      setData(await api.schedules.remove(projectId, s.id));
      setNotice({ text: `Deleted “${s.name}”. Its past runs are still in the sidebar.` });
    });

  const schedules = data?.schedules ?? [];
  const serverTz = data?.serverTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 [&_svg]:size-4">
          <CalendarClock className="shrink-0 text-accent" />
          <h3 className="text-base font-semibold text-primary">Scheduled chats</h3>
          <Chip tone={schedules.length ? "accent" : "muted"} mono>
            {schedules.length}
          </Chip>
          {loading && <Spinner size={12} />}
          {!editing && (
            <Button className="ml-auto" variant="subtle" leftIcon={<Plus />} onClick={() => setEditing({ mode: "new" })}>
              New schedule
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          A prompt Dispatch starts as a fresh chat on a schedule — a morning dependency audit, a weekly
          flaky-test sweep. Each run is its own chat, and it is told where the previous runs are so it can
          build on what they found. Saved as <code className="font-mono">.dispatch/schedules/&lt;id&gt;.md</code>,
          committed with the repo.
        </p>
      </div>

      {data && !data.active && (
        <p className="rounded-md border border-line-soft px-3 py-2 text-2xs text-faint">
          This instance doesn&apos;t fire schedules on its own (only the installed app does) — Run now still works.
        </p>
      )}

      {notice && (
        <p className="flex items-center gap-2 text-xs text-secondary">
          {notice.text}
          {notice.chatId && (
            <Button variant="link" onClick={() => selectChat(notice.chatId!)}>
              Open chat
            </Button>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-danger [&_svg]:mt-0.5 [&_svg]:size-3.5">
          <AlertTriangle className="shrink-0" />
          {error}
        </p>
      )}

      {editing?.mode === "new" && (
        <ScheduleEditor
          projectId={projectId}
          initial={null}
          takenIds={new Set(schedules.map((v) => v.schedule.id))}
          personas={personas}
          serverTimeZone={serverTz}
          onCancel={() => setEditing(null)}
          onSaved={(res) => {
            setData(res);
            setEditing(null);
          }}
        />
      )}

      {schedules.length === 0 && !loading && editing?.mode !== "new" && (
        <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
          No scheduled chats yet.
        </div>
      )}

      <ul className="space-y-2">
        {schedules.map((view) =>
          editing?.mode === "edit" && editing.schedule.id === view.schedule.id ? (
            <li key={view.schedule.id}>
              <ScheduleEditor
                projectId={projectId}
                initial={view.schedule}
                takenIds={new Set()}
                personas={personas}
                serverTimeZone={serverTz}
                onCancel={() => setEditing(null)}
                onSaved={(res) => {
                  setData(res);
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <ScheduleRow
              key={view.schedule.id}
              view={view}
              personas={personas}
              serverTimeZone={serverTz}
              busy={busy === view.schedule.id}
              disabled={!!busy || !!editing}
              onRun={() => void runNow(view.schedule)}
              onEdit={() => setEditing({ mode: "edit", schedule: view.schedule })}
              onToggle={() => void toggle(view.schedule)}
              onDelete={() => void remove(view.schedule)}
            />
          ),
        )}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------- row */

function ScheduleRow({
  view,
  personas,
  serverTimeZone,
  busy,
  disabled,
  onRun,
  onEdit,
  onToggle,
  onDelete,
}: {
  view: ScheduleView;
  personas: Persona[];
  serverTimeZone: string;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { schedule: s, state, nextRunAt, runs } = view;
  const tz = s.timezone ?? serverTimeZone;
  const persona = s.personaId ? (personas.find((p) => p.id === s.personaId)?.name ?? s.personaId) : null;
  const runsAs = [
    persona && `as ${persona}`,
    s.harness && providerFor(s.harness).label,
    s.model,
    s.effort && `${s.effort} effort`,
  ].filter(Boolean);

  return (
    <li className={cn("rounded-md border border-line bg-panel-2/40 px-3 py-2.5", !s.enabled && "opacity-80")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-primary">{s.name}</span>
            <span className="font-mono text-2xs text-faint">{s.id}</span>
            {!s.enabled && <Chip tone="muted">paused</Chip>}
          </div>
          <div className="mt-0.5 text-xs text-secondary">
            {describeCron(s.cron)}
            <span className="text-faint"> · {tz}</span>
            {runsAs.length > 0 && <span className="text-faint"> · {runsAs.join(" · ")}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy && <Spinner size={12} />}
          <Button variant="subtle" leftIcon={<Zap />} disabled={disabled} onClick={onRun} title="Start a run now">
            Run now
          </Button>
          <Button
            variant="ghost"
            leftIcon={s.enabled ? <Pause /> : <Play />}
            disabled={disabled}
            onClick={onToggle}
            title={s.enabled ? "Stop firing on the schedule (Run now still works)" : "Resume firing on the schedule"}
          >
            {s.enabled ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" leftIcon={<SquarePen />} disabled={disabled} onClick={onEdit}>
            Edit
          </Button>
          {confirming ? (
            <>
              <Button variant="danger" disabled={disabled} onClick={() => { setConfirming(false); onDelete(); }}>
                Delete
              </Button>
              <Button variant="link" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" leftIcon={<Trash2 />} disabled={disabled} onClick={() => setConfirming(true)} aria-label={`Delete ${s.name}`} />
          )}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
        <dt className="text-faint">Next run</dt>
        <dd className="text-secondary">
          {nextRunAt ? (
            <>
              {untilTime(nextRunAt)} <span className="text-faint">· {wallClock(nextRunAt, tz)}</span>
            </>
          ) : (
            <span className="text-faint">{s.enabled ? "never — the cron has no future fire" : "paused"}</span>
          )}
        </dd>
        <dt className="text-faint">Last run</dt>
        <dd className="text-secondary">
          {state?.lastRunAt && state.lastChatId ? (
            <>
              <Button variant="link" className="!h-auto !p-0 text-2xs" onClick={() => selectChat(state.lastChatId!)}>
                {relTime(state.lastRunAt)}
              </Button>
              {state.lastTrigger && state.lastTrigger !== "schedule" && (
                <span className="text-faint"> · {state.lastTrigger === "manual" ? "run by hand" : "catch-up"}</span>
              )}
            </>
          ) : (
            <span className="text-faint">not yet</span>
          )}
        </dd>
        {state?.lastError && (
          <>
            <dt className="text-danger">Failed</dt>
            <dd className="text-danger">{state.lastError}</dd>
          </>
        )}
        {state?.lastSkip && (
          <>
            <dt className="text-faint">Skipped</dt>
            <dd className="text-muted">{state.lastSkip}</dd>
          </>
        )}
      </dl>

      {runs.length > 0 && (
        <details className="group mt-2 text-2xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-faint hover:text-secondary [&_svg]:size-3">
            <ChevronRight className="transition-transform group-open:rotate-90" />
            {runs.length} past run{runs.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1.5 space-y-1 pl-4">
            {runs.map((r) => (
              <li key={r.chatId} className="flex items-center gap-2">
                <Button variant="link" className="!h-auto !p-0 text-2xs" onClick={() => selectChat(r.chatId)}>
                  {wallClock(r.createdAt, tz)}
                </Button>
                <Chip tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Chip>
                {r.archived && <span className="text-faint">archived</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/* ----------------------------------------------------------------- editor */

type PresetKind = SchedulePreset["kind"] | "custom";

const PRESET_KIND_OPTIONS: SelectOption<PresetKind>[] = [
  { value: "minutes", label: "Every few minutes" },
  { value: "hours", label: "Every few hours" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom (cron)" },
];

/** A preset of `kind` that keeps whatever time-of-day the current one had. */
function presetOfKind(kind: SchedulePreset["kind"], from: SchedulePreset | null): SchedulePreset {
  const hour = from && "hour" in from ? from.hour : 9;
  const minute = from && "minute" in from ? from.minute : 0;
  switch (kind) {
    case "minutes":
      return { kind, every: 30 };
    case "hours":
      return { kind, every: 1, minute };
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, day: 1, hour, minute };
    case "monthly":
      return { kind, date: 1, hour, minute };
  }
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function ScheduleEditor({
  projectId,
  initial,
  takenIds,
  personas,
  serverTimeZone,
  onCancel,
  onSaved,
}: {
  projectId: string;
  /** Null for a new schedule. */
  initial: Schedule | null;
  takenIds: Set<string>;
  personas: Persona[];
  serverTimeZone: string;
  onCancel: () => void;
  onSaved: (res: SchedulesResponse) => void;
}) {
  const [draft, setDraft] = useState<ScheduleInput>(
    initial
      ? toInput(initial)
      : { id: "", name: "", cron: presetToCron({ kind: "weekdays", hour: 9, minute: 0 }), prompt: "", enabled: true, catchUp: true },
  );
  // The id follows the name until the human types one — after that it's theirs.
  const [idTouched, setIdTouched] = useState(false);
  const [preset, setPreset] = useState<SchedulePreset | null>(() => cronToPreset(draft.cron));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<ScheduleInput>) => setDraft((d) => ({ ...d, ...p }));

  const setFrequency = (p: SchedulePreset) => {
    setPreset(p);
    patch({ cron: presetToCron(p) });
  };

  const tz = draft.timezone?.trim() || undefined;
  const check = useMemo(() => checkCron(draft.cron, tz), [draft.cron, tz]);
  const preview = useMemo(
    () => (check.ok ? nextFires(draft.cron, 3, Date.now(), tz) : []),
    [check.ok, draft.cron, tz],
  );

  const id = initial ? initial.id : draft.id;
  const idError = !id
    ? "Give it a name — the id is derived from it."
    : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
      ? "Lowercase letters, digits and dashes."
      : !initial && takenIds.has(id)
        ? "A schedule with this id already exists."
        : null;
  const canSave = !saving && !idError && check.ok && !!draft.name.trim() && !!draft.prompt.trim();

  const { harnesses, catalogs } = useProviderCatalogs();
  const providerOptions: SelectOption<string>[] = [
    { value: "", label: "Same as the project", hint: "follows it" },
    ...providerIds().map((kind) => {
      const runtime = harnesses.find((h) => h.kind === kind)?.runtime;
      return {
        value: kind,
        label: providerFor(kind).label,
        hint: !harnesses.length ? undefined : runtime?.available ? (runtime.version ?? runtime.source) : "not installed",
      };
    }),
  ];
  const catalog = draft.harness ? (catalogs[draft.harness] ?? []) : [];
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "Provider default", hint: "unpinned" },
    ...catalog.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
    ...(draft.model && !catalog.some((m) => m.value === draft.model)
      ? [{ value: draft.model, label: draft.model, hint: "not in catalog" }]
      : []),
  ];
  const personaOptions: SelectOption<string>[] = [
    { value: "", label: "None" },
    ...personas.map((p) => ({ value: p.id, label: p.name, hint: p.scope })),
    ...(draft.personaId && !personas.some((p) => p.id === draft.personaId)
      ? [{ value: draft.personaId, label: draft.personaId, hint: "not found" }]
      : []),
  ];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await api.schedules.save(projectId, {
          ...draft,
          id,
          name: draft.name.trim(),
          timezone: tz,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const timeInput = (p: Extract<SchedulePreset, { hour: number }>) => (
    <input
      type="time"
      aria-label="Time of day"
      value={hhmm(p.hour, p.minute)}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) setFrequency({ ...p, hour: h!, minute: m! });
      }}
      className={cn(inputClass, "w-28")}
    />
  );

  return (
    <div className="space-y-3 rounded-md border border-accent-line bg-panel-2/40 px-3 py-3">
      <div className="text-xs font-semibold text-primary">{initial ? `Edit “${initial.name}”` : "New scheduled chat"}</div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
        <label className="flex flex-col text-2xs text-faint">
          Name
          <input
            autoFocus={!initial}
            value={draft.name}
            placeholder="e.g. Morning dependency audit"
            onChange={(e) => {
              const name = e.target.value;
              patch(initial || idTouched ? { name } : { name, id: toAuthoredName(name) ?? "" });
            }}
            className={cn(inputClass, "mt-1 w-full")}
          />
        </label>
        <label className="flex flex-col text-2xs text-faint">
          <span>Id {initial && <span>(fixed — past runs are keyed on it)</span>}</span>
          <input
            value={id}
            disabled={!!initial}
            onChange={(e) => {
              setIdTouched(true);
              patch({ id: e.target.value });
            }}
            className={cn(inputClass, "mt-1 w-full font-mono sm:w-56")}
          />
        </label>
      </div>
      {idError && draft.name && <p className="text-2xs text-danger">{idError}</p>}

      <label className="block text-2xs text-faint">
        Prompt — what each run is asked
        <textarea
          value={draft.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
          rows={5}
          placeholder="e.g. Check for outdated or vulnerable dependencies. Open a PR for safe patch bumps; list anything that needs a decision."
          className={cn(
            "mt-1 w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2",
            "text-xs leading-relaxed text-secondary placeholder:text-faint",
            "focus:border-accent-line focus:outline-none",
          )}
        />
      </label>

      {/* ---- frequency */}
      <div className="space-y-2 rounded-md border border-line-soft px-3 py-2.5">
        <div className="text-xs font-medium text-secondary">When it runs</div>
        <div className="flex flex-wrap items-center gap-2">
          <Select<PresetKind>
            options={PRESET_KIND_OPTIONS}
            value={preset?.kind ?? "custom"}
            onChange={(k) => {
              if (k === "custom") setPreset(null);
              else setFrequency(presetOfKind(k, preset));
            }}
            leftIcon={<CalendarClock />}
            width={200}
          />
          {preset?.kind === "minutes" && (
            <Select<string>
              options={MINUTE_STEPS.map((n) => ({ value: String(n), label: `every ${n} min` }))}
              value={String(preset.every)}
              onChange={(v) => setFrequency({ ...preset, every: Number(v) })}
              width={150}
            />
          )}
          {preset?.kind === "hours" && (
            <>
              <Select<string>
                options={HOUR_STEPS.map((n) => ({ value: String(n), label: n === 1 ? "every hour" : `every ${n} hours` }))}
                value={String(preset.every)}
                onChange={(v) => setFrequency({ ...preset, every: Number(v) })}
                width={150}
              />
              <label className="flex items-center gap-1.5 text-2xs text-faint">
                at minute
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={preset.minute}
                  onChange={(e) => {
                    const n = Math.min(59, Math.max(0, Math.trunc(Number(e.target.value) || 0)));
                    setFrequency({ ...preset, minute: n });
                  }}
                  className={cn(inputClass, "w-16")}
                />
              </label>
            </>
          )}
          {(preset?.kind === "daily" || preset?.kind === "weekdays") && timeInput(preset)}
          {preset?.kind === "weekly" && (
            <>
              <Select<string>
                options={WEEKDAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
                value={String(preset.day)}
                onChange={(v) => setFrequency({ ...preset, day: Number(v) })}
                width={150}
              />
              {timeInput(preset)}
            </>
          )}
          {preset?.kind === "monthly" && (
            <>
              <Select<string>
                options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `on day ${i + 1}` }))}
                value={String(preset.date)}
                onChange={(v) => setFrequency({ ...preset, date: Number(v) })}
                width={130}
              />
              {timeInput(preset)}
            </>
          )}
          {!preset && (
            <input
              value={draft.cron}
              aria-label="Cron expression"
              placeholder="minute hour day month weekday"
              onChange={(e) => patch({ cron: e.target.value })}
              className={cn(inputClass, "w-48 font-mono")}
            />
          )}
          <label className="flex items-center gap-1.5 text-2xs text-faint">
            Time zone
            <input
              value={draft.timezone ?? ""}
              placeholder={serverTimeZone}
              onChange={(e) => patch({ timezone: e.target.value || undefined })}
              className={cn(inputClass, "w-44")}
            />
          </label>
        </div>
        {check.ok ? (
          <div className="text-2xs text-faint">
            <span className="font-mono">{draft.cron}</span> — next:{" "}
            {preview.length ? preview.map((t) => wallClock(t, tz ?? serverTimeZone)).join(" · ") : "never"}
          </div>
        ) : (
          <div className="text-2xs text-danger">{check.error}</div>
        )}
      </div>

      {/* ---- runs as */}
      <div className="space-y-2 rounded-md border border-line-soft px-3 py-2.5">
        <div className="text-xs font-medium text-secondary">Each run starts as</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2">
            <span className="text-2xs text-faint">Persona</span>
            <Select<string>
              options={personaOptions}
              value={draft.personaId ?? ""}
              onChange={(v) => patch({ personaId: v || undefined })}
              width={180}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-2xs text-faint">Provider</span>
            <Select<string>
              options={providerOptions}
              value={draft.harness ?? ""}
              onChange={(v) => {
                const harness = (v || undefined) as HarnessKind | undefined;
                if (harness === draft.harness) return;
                patch({ harness, model: undefined });
              }}
              leftIcon={<Cpu />}
              width={200}
            />
          </label>
          {/* Always shown — the model is one of the things a schedule is FOR. A
              model id belongs to one provider, though, so it can only be pinned
              once the provider is; until then the select says why it's inert. */}
          <label
            className="flex items-center gap-2"
            title={draft.harness ? undefined : "Pick a provider to pin a model"}
          >
            <span className="text-2xs text-faint">Model</span>
            <Select<string>
              options={
                draft.harness ? modelOptions : [{ value: "", label: "Project default", hint: "pick a provider to pin" }]
              }
              value={draft.model ?? ""}
              onChange={(v) => patch({ model: v || undefined })}
              width={220}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-2xs text-faint">Effort</span>
            <Select<Effort | "">
              options={[{ value: "", label: "Project default", hint: "inherit" }, ...EFFORT_OPTIONS]}
              value={draft.effort ?? ""}
              onChange={(v) => patch({ effort: (v || undefined) as Effort | undefined })}
              leftIcon={<Gauge />}
              width={170}
            />
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <ToggleRow
          checked={draft.enabled !== false}
          onChange={(enabled) => patch({ enabled })}
          title="Enabled"
          description="Off pauses the schedule — nothing fires on its own, but Run now still works."
        />
        <ToggleRow
          checked={draft.catchUp !== false}
          onChange={(catchUp) => patch({ catchUp })}
          title="Catch up on missed runs"
          description="If a run was missed while Dispatch was off, run once on startup — once, however many slots were missed."
        />
      </div>

      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="link" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          leftIcon={saving ? <Spinner size={12} /> : <Save />}
          disabled={!canSave}
          onClick={() => void save()}
        >
          {initial ? "Save" : "Create schedule"}
        </Button>
      </div>
    </div>
  );
}
