/**
 * TaskLauncherDialog — "Create with AI", as a dialog.
 *
 * The config view used to grow an inline describe-it box under every section's
 * list. It worked, but it competed with the list for the pane: a section you
 * were reading always had a half-page form under it, and the form was cramped
 * anyway (three rows of textarea for something you're writing a paragraph in).
 *
 * As a dialog it's the opposite trade — invisible until you ask for it, then
 * given the whole width for the one thing you're doing. The launcher itself is
 * unchanged; it renders {@link TaskLauncher} `bare`, because the dialog header
 * already carries the task's icon, verb and blurb and printing them twice six
 * pixels apart is just noise.
 *
 * Its icon and copy come from the task's catalog entry, so every task announces
 * itself with its OWN icon — the same one the sidebar will put on the chat this
 * spawns. No task is named in this file.
 */
import { AGENT_TASKS, type AgentTaskId } from "@dispatch/shared";
import type { ReactNode } from "react";
import { Modal } from "../sidebar/Modal.js";
import { TaskLauncher } from "./TaskLauncher.js";
import { taskIcon } from "../../lib/taskIcons.js";

export function TaskLauncherDialog({
  taskId,
  projectId,
  open,
  onClose,
  params,
  disabled,
  blockedReason,
  secondary,
  onLaunched,
}: {
  taskId: AgentTaskId;
  projectId: string | null;
  open: boolean;
  onClose: () => void;
  params?: Record<string, unknown>;
  disabled?: boolean;
  blockedReason?: string;
  /** Extra affordance beside the launch button (e.g. "Edit project.yaml"). */
  secondary?: ReactNode;
  /** Fires after the chat is spawned; the dialog closes itself either way. */
  onLaunched?: (chatId: string) => void;
}) {
  const meta = AGENT_TASKS[taskId];
  const Icon = taskIcon(meta.icon);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      icon={<Icon />}
      title={meta.action}
      description={meta.blurb}
    >
      <TaskLauncher
        bare
        autoFocus
        taskId={taskId}
        projectId={projectId}
        params={params}
        disabled={disabled}
        blockedReason={blockedReason}
        secondary={secondary}
        onLaunched={(chatId) => {
          onClose();
          onLaunched?.(chatId);
        }}
      />
    </Modal>
  );
}
