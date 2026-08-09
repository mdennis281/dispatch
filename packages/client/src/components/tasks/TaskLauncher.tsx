/**
 * TaskLauncher — the one form behind every "describe it and an agent does it"
 * affordance: custom instructions, the run settings (model + effort), whatever
 * toggles the task declares, and a button that spawns the chat.
 *
 * There used to be exactly one of these, hand-built inside the project-config
 * pane. The moment a second feature wanted the same thing the honest options
 * were "copy it" or "make it a component", and the copy would have shipped
 * without the effort selector — the config box never had one, so every config
 * chat ran at whatever `medium` gives you.
 *
 * Everything task-specific comes from the shared catalog (`AGENT_TASKS`): the
 * button verb, the noun, the placeholder, the icon, the title prefix, the
 * default model/effort, the toggles. This component knows about none of them by
 * name. Adding a task means adding a catalog entry and a server-side briefing —
 * no UI change.
 *
 * Launching leaves: the spawned chat becomes the active one and `onLaunched`
 * fires so the host can close itself. The work is visible in the chat, where it
 * can be read and steered, rather than behind a spinner in a dialog.
 */
import { useState, type ReactNode } from "react";
import { Send, SlidersHorizontal } from "lucide-react";
import { AGENT_TASKS, type AgentTaskId } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { InlineError } from "../sidebar/Modal.js";
import { TaskRunSettings, runSummary } from "./TaskRunSettings.js";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { taskIcon } from "../../lib/taskIcons.js";
import { useTaskRunPrefs } from "../../lib/taskPrefs.js";
import { useChats } from "../../stores/chats.js";
import { useModels } from "../../stores/models.js";
import { useNotices } from "../../stores/notices.js";
import { useView } from "../../stores/view.js";

export interface TaskLauncherProps {
  taskId: AgentTaskId;
  projectId: string | null;
  /**
   * Produce the project to launch into, at launch time, when it doesn't exist
   * yet. The new-project page is the whole reason: its task is "finish setting
   * up this project", and the project only becomes real when you press the
   * button — creating it earlier would leave a half-configured record behind
   * every time someone opened the page and changed their mind.
   *
   * Called only when `projectId` is null. Throwing surfaces in the launcher's
   * own error strip, so a failed create reads as a failed launch, which is what
   * it is.
   */
  resolveProjectId?: () => Promise<string>;
  /** Overrides the launch button's verb (defaults to "Have Claude do it"). */
  submitLabel?: string;
  /**
   * Task-specific values merged into the launch `params` — a sweep's target
   * repo, for instance. Toggle values are collected here too and win over these
   * only for keys the toggles own.
   */
  params?: Record<string, unknown>;
  /** Disables the whole form (host is mid-save, no repo selected, …). */
  disabled?: boolean;
  /** Reason the launch is blocked, shown instead of the hint line. */
  blockedReason?: string;
  /** Extra affordance beside the launch button (e.g. "Edit project.yaml"). */
  secondary?: ReactNode;
  /** Called after the chat is spawned and focused — hosts usually close here. */
  onLaunched?: (chatId: string) => void;
  /** Compact spacing for a popover; the default suits a dialog pane. */
  dense?: boolean;
  /**
   * Drop the framed heading (icon + action + blurb) and the panel border.
   *
   * For hosts that already say what this is — {@link TaskLauncherDialog} puts
   * exactly that text in the dialog's own header, and repeating it inside would
   * be the same sentence twice, six pixels apart.
   */
  bare?: boolean;
  /** Autofocus the instructions box (a dialog opens straight into typing). */
  autoFocus?: boolean;
}

/** Initial toggle state straight from the catalog's declared defaults. */
function initialToggles(taskId: AgentTaskId): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of AGENT_TASKS[taskId].toggles ?? []) out[t.id] = t.default;
  return out;
}

export function TaskLauncher({
  taskId,
  projectId,
  resolveProjectId,
  submitLabel,
  params,
  disabled,
  blockedReason,
  secondary,
  onLaunched,
  dense,
  bare,
  autoFocus,
}: TaskLauncherProps) {
  const meta = AGENT_TASKS[taskId];
  const Icon = taskIcon(meta.icon);
  const [instructions, setInstructions] = useState("");
  // Model + effort live in their own dialog and are remembered per task, seeded
  // from the catalog's defaults: a commit sweep starts deeper than a config file
  // because the grouping decision is genuinely harder. See lib/taskPrefs.
  const prefs = useTaskRunPrefs(taskId);
  const models = useModels((s) => s.models);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toggles, setToggles] = useState(() => initialToggles(taskId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = (!!projectId || !!resolveProjectId) && !disabled && !blockedReason;
  const canLaunch = ready && !sending && (!meta.instructionsRequired || !!instructions.trim());

  async function launch() {
    if (!canLaunch) return;
    setSending(true);
    setError(null);
    try {
      // Either the host already has a project, or it makes one now. Anything
      // thrown here (a path that can't be created, a name the server rejects)
      // lands in the same error strip as a failed launch.
      const id = projectId ?? (await resolveProjectId!());
      const out = await api.tasks.launch(id, {
        taskId,
        instructions: instructions.trim() || undefined,
        effort: prefs.effort,
        model: prefs.model,
        params: { ...params, ...toggles },
      });
      setInstructions("");
      setToggles(initialToggles(taskId));
      // Focus the chat AND switch to the chat surface: launching from Source
      // Control otherwise "does nothing" — the chat is active behind a view the
      // user isn't looking at.
      useChats.getState().setActiveChat(out.chat.id);
      useView.getState().setView("chat");
      useNotices.getState().push({ level: "info", text: `Started “${out.chat.title}”` });
      onLaunched?.(out.chat.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={cn(!bare && "rounded-md border border-line bg-panel-2/40")}>
      {!bare && (
        <div className="flex items-center gap-2 px-3 py-2 [&_svg]:size-3.5">
          {/* The task's own icon, straight off its catalog entry — the same one
              the sidebar puts on the chat this launches, so the two are
              recognizably the same thing. */}
          <Icon className="shrink-0 text-accent" />
          <span className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-primary">
            {meta.action}
          </span>
          {/* The blurb yields first: a wrapped heading reads as two headings. */}
          <span className="ml-auto min-w-0 truncate text-[10.5px] text-faint" title={meta.blurb}>
            {meta.blurb}
          </span>
        </div>
      )}

      <div
        className={cn(
          "space-y-2",
          !bare && "border-t border-line-soft",
          bare ? "p-0" : dense ? "p-2" : "p-2.5",
        )}
      >
        <textarea
          autoFocus={autoFocus}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void launch();
          }}
          // A bare dialog gives the ask room to be a paragraph; a bare strip
          // pinned under a form is one control among many and stays short.
          rows={bare ? (dense ? 3 : 5) : dense ? 2 : 3}
          placeholder={meta.placeholder}
          disabled={sending || !ready}
          className={cn(
            "w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2",
            "leading-relaxed text-secondary placeholder:text-faint",
            // A dialog gives the description the room it deserves; inline, it's
            // one control among many and stays at the pane's type scale.
            bare ? "text-[12.5px]" : "text-[11.5px]",
            "focus:border-accent-line focus:outline-none disabled:opacity-60",
          )}
        />

        {meta.toggles && meta.toggles.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {meta.toggles.map((t) => (
              <label
                key={t.id}
                title={t.hint}
                className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted hover:text-secondary"
              >
                <input
                  type="checkbox"
                  checked={toggles[t.id] ?? t.default}
                  disabled={sending || !ready}
                  onChange={(e) => setToggles((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                  className="size-3 accent-[var(--p-accent)]"
                />
                {t.label}
              </label>
            ))}
          </div>
        )}

        {error && <InlineError message={error} />}

        <div className="flex items-center gap-2">
          {blockedReason ? (
            <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-warn">
              {blockedReason}
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-faint">
              Opens a chat here — it reads the repo first and you can steer it.
            </span>
          )}
          {/* Model + effort as ONE summary chip beside the launch button: they're
              a statement about this run, read far more often than they're
              changed, and the full pickers live behind them (TaskRunSettings). */}
          <Button
            variant="subtle"
            leftIcon={<SlidersHorizontal />}
            disabled={sending}
            onClick={() => setSettingsOpen(true)}
            title="Model and reasoning effort for this task"
          >
            {runSummary(models, prefs)}
          </Button>
          {secondary}
          <Button
            variant="primary"
            leftIcon={sending ? <Spinner size={12} /> : <Send />}
            disabled={!canLaunch}
            onClick={() => void launch()}
          >
            {sending ? "Starting…" : (submitLabel ?? "Have Claude do it")}
          </Button>
        </div>
      </div>

      <TaskRunSettings
        taskId={taskId}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={prefs}
      />
    </div>
  );
}
