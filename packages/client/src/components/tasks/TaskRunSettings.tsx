/**
 * The dedicated "what does this run on" dialog: model + reasoning effort for a
 * task launch.
 *
 * These two live in a modal rather than inline in the launcher for the same
 * reason the composer doesn't put them in the message box — they are set rarely
 * and read constantly. Inline, they crowded the one control that matters (the
 * description) and the effort picker still had to be squeezed in beside the
 * launch button. As a modal, the launcher shows a single summary chip
 * ("Opus · High") that reads as a statement about the run, and the full choice
 * with its hints and blurbs opens when you actually want it.
 *
 * The picks are remembered per task (see `lib/taskPrefs`) and this dialog writes
 * them straight through — there's no cancel, because every change is a change
 * you can see reflected in the chip behind the dialog and undo by picking
 * again. "Reset" restores the catalog's own defaults for the task.
 */
import type { ReactNode } from "react";
import {
  Brain,
  Check,
  CircleDot,
  Cpu,
  Feather,
  Flame,
  Gauge,
  Rabbit,
  Rocket,
  RotateCcw,
  Scale,
  Sparkles,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  AGENT_TASKS,
  findModel,
  type AgentTaskId,
  type Effort,
  type ModelOption,
} from "@dispatch/shared";
import { Modal } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { taskDefaults, isCustomized, useTaskPrefs, type TaskRunPrefs } from "../../lib/taskPrefs.js";
import { taskIcon } from "../../lib/taskIcons.js";
import { useModels } from "../../stores/models.js";
import { cn } from "../../lib/cn.js";

/* ------------------------------------------------------------------ icons */

/**
 * A distinct icon per choice, so a list of options is scannable by shape rather
 * than by reading five rows that all start with the same glyph.
 *
 * Models are matched on their LABEL, not a fixed table: the list comes live off
 * the Claude Code runtime, so tomorrow's model arrives without a code change and
 * simply falls back to the generic chip.
 */
function modelIcon(label: string): LucideIcon {
  const l = label.toLowerCase();
  if (l.includes("opus")) return Brain;
  if (l.includes("fable")) return Wand2;
  if (l.includes("sonnet")) return Scale;
  if (l.includes("haiku")) return Rabbit;
  if (l.includes("default")) return Sparkles;
  return Cpu;
}

/** Effort, as a ramp: light → fast → deep. */
const EFFORT_ICONS: Record<Effort, LucideIcon> = {
  low: Feather,
  medium: Gauge,
  high: Flame,
  xhigh: Zap,
  max: Rocket,
};

/** Display label for a pinned model id, falling back to the raw id. */
export function modelLabel(models: ModelOption[], id: string): string {
  return findModel(models, id)?.label ?? id;
}

/** The launcher's one-line summary of where a launch will run. */
export function runSummary(models: ModelOption[], prefs: TaskRunPrefs): string {
  const effort = EFFORT_OPTIONS.find((e) => e.value === prefs.effort)?.label ?? prefs.effort;
  return prefs.model ? `${modelLabel(models, prefs.model)} · ${effort}` : effort;
}

/* ------------------------------------------------------------------- rows */

function OptionRow({
  icon,
  label,
  hint,
  detail,
  selected,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={detail}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-[7px] text-left transition-colors",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        selected
          ? "border-accent-line bg-accent-ghost text-primary"
          : "border-transparent text-secondary hover:border-line hover:bg-panel-2/50",
      )}
    >
      <span className={selected ? "text-accent" : "text-faint"}>{icon}</span>
      <span className="min-w-0 truncate text-sm">{label}</span>
      {hint && <span className="shrink-0 text-2xs text-faint">{hint}</span>}
      {selected && <Check className="ml-auto text-accent" />}
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 mt-3 flex items-center gap-1.5 text-2xs uppercase tracking-wide text-faint first:mt-0 [&_svg]:size-3">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ modal */

export function TaskRunSettings({
  taskId,
  open,
  onClose,
  prefs,
}: {
  taskId: AgentTaskId;
  open: boolean;
  onClose: () => void;
  prefs: TaskRunPrefs;
}) {
  const meta = AGENT_TASKS[taskId];
  const TaskIcon = taskIcon(meta.icon);
  const models = useModels((s) => s.models);
  const setPrefs = useTaskPrefs((s) => s.set);
  const resetPrefs = useTaskPrefs((s) => s.reset);
  const defaults = taskDefaults(taskId);
  const customized = isCustomized(taskId, prefs);

  const pickModel = (model: string | undefined) => setPrefs(taskId, { ...prefs, model });
  const pickEffort = (effort: Effort) => setPrefs(taskId, { ...prefs, effort });

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={420}
      // The TASK's icon, not a generic settings glyph: this dialog opens over
      // the launcher it belongs to, and the icon is what says which one.
      icon={<TaskIcon />}
      title={`Run settings — ${meta.action.toLowerCase()}`}
      description="Remembered for this task, on this browser."
      footer={
        <>
          <span className="min-w-0 flex-1 text-2xs leading-snug text-faint">
            {customized
              ? `Default for this task: ${runSummary(models, defaults)}`
              : "Using this task's defaults."}
          </span>
          {customized && (
            <Button variant="ghost" leftIcon={<RotateCcw />} onClick={() => resetPrefs(taskId)}>
              Reset
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <GroupLabel>
        <Cpu /> Model
      </GroupLabel>
      <div className="flex flex-col gap-0.5">
        {/* Inherit is its own row, not the absence of a choice: an unpinned chat
            keeps tracking the project/runtime recommendation, which is a real
            (and usually correct) answer rather than a null one. */}
        <OptionRow
          icon={<CircleDot />}
          label="Inherit"
          hint="project default"
          detail="Leaves the chat unpinned — it follows whatever this project recommends."
          selected={!prefs.model}
          onClick={() => pickModel(undefined)}
        />
        {models.map((m) => {
          const ModelIcon = modelIcon(m.label);
          return (
          <OptionRow
            key={m.value}
            icon={<ModelIcon />}
            label={m.label}
            hint={m.hint}
            detail={m.description}
            selected={prefs.model === m.value}
            onClick={() => pickModel(m.value)}
          />
          );
        })}
      </div>

      <GroupLabel>
        <Gauge /> Effort
      </GroupLabel>
      <div className="flex flex-col gap-0.5">
        {EFFORT_OPTIONS.map((e) => {
          const EffortIcon = EFFORT_ICONS[e.value];
          return (
            <OptionRow
              key={e.value}
              icon={<EffortIcon />}
              label={e.label}
              hint={e.hint}
              selected={prefs.effort === e.value}
              onClick={() => pickEffort(e.value)}
            />
          );
        })}
      </div>
    </Modal>
  );
}
