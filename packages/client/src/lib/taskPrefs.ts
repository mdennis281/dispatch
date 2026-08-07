/**
 * The model + effort a task launches at, remembered per task.
 *
 * The catalog ships a sensible default per task (a commit sweep starts at
 * `high`, a config file at `medium`), but a default is a starting point, not an
 * opinion about how YOU work. Someone who always sweeps on Opus was re-picking
 * it every single launch, and a knob you have to re-set every time is a knob you
 * eventually stop setting.
 *
 * So: last-used wins, keyed by task id. Per TASK rather than globally, because
 * the whole reason the catalog carries per-task defaults is that these jobs are
 * genuinely different sizes — one preference across all of them would flatten
 * exactly the distinction it exists to preserve.
 *
 * Stored in localStorage (a statement about how you work, not about one
 * project), with every access guarded: localStorage throws under a blocking
 * cookie policy and doesn't exist in the node test environment. Same shape as
 * `composerPrefs` — if you're changing one, look at the other.
 */
import { create } from "zustand";
import { AGENT_TASKS, type AgentTaskId, type Effort } from "@dispatch/shared";

/** What a launch runs at. `model: undefined` means "inherit the default". */
export interface TaskRunPrefs {
  effort: Effort;
  model?: string;
}

const KEY = "cm:task-run-prefs";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

/** The catalog's own answer for a task — what "reset" restores. */
export function taskDefaults(taskId: AgentTaskId): TaskRunPrefs {
  const meta = AGENT_TASKS[taskId];
  return { effort: meta.defaultEffort, model: meta.defaultModel };
}

type Stored = Partial<Record<AgentTaskId, TaskRunPrefs>>;

/**
 * Tolerant load: anything that isn't a recognizable `{effort, model?}` for a
 * known task id is dropped, so a stale or hand-edited entry degrades to the
 * catalog default rather than launching at a level that doesn't exist.
 */
function load(): Stored {
  try {
    const raw = backing()?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Stored = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!(id in AGENT_TASKS) || !value || typeof value !== "object") continue;
      const { effort, model } = value as { effort?: unknown; model?: unknown };
      if (typeof effort !== "string") continue;
      out[id as AgentTaskId] = {
        effort: effort as Effort,
        ...(typeof model === "string" ? { model } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(byTask: Stored): void {
  try {
    backing()?.setItem(KEY, JSON.stringify(byTask));
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

interface TaskPrefsStore {
  byTask: Stored;
  /** Overwrite this task's remembered run settings. */
  set: (taskId: AgentTaskId, prefs: TaskRunPrefs) => void;
  /** Forget them — the next launch reads the catalog default again. */
  reset: (taskId: AgentTaskId) => void;
}

export const useTaskPrefs = create<TaskPrefsStore>((set) => ({
  byTask: load(),
  set: (taskId, prefs) =>
    set((s) => {
      const byTask = { ...s.byTask, [taskId]: prefs };
      persist(byTask);
      return { byTask };
    }),
  reset: (taskId) =>
    set((s) => {
      const byTask = { ...s.byTask };
      delete byTask[taskId];
      persist(byTask);
      return { byTask };
    }),
}));

/** What this task should launch at right now: remembered, else the catalog. */
export function useTaskRunPrefs(taskId: AgentTaskId): TaskRunPrefs {
  const stored = useTaskPrefs((s) => s.byTask[taskId]);
  return stored ?? taskDefaults(taskId);
}

/** True when the remembered settings differ from the catalog's — drives "reset". */
export function isCustomized(taskId: AgentTaskId, prefs: TaskRunPrefs): boolean {
  const d = taskDefaults(taskId);
  return prefs.effort !== d.effort || (prefs.model ?? null) !== (d.model ?? null);
}
