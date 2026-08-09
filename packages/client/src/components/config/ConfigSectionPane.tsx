/**
 * ConfigSectionPane — the detail half of the project-config view.
 *
 * One section at a time: what it is, what this project currently has, and the
 * two ways to add to it — open the file and write it yourself, or describe what
 * you want and let an agent do it in a chat you can watch.
 *
 * The item rows deliberately carry their SOURCE FILE. Every kind of config here
 * is a file in the repo, and the honest affordance is "open that file", not a
 * bespoke form per kind that would drift from the format the loader actually
 * accepts. Manifest-backed kinds (MCP servers, sub-apps) point at project.yaml,
 * because that genuinely is where they live.
 *
 * The describe-it form is no longer this file's business: it's the shared
 * launcher, reached through a "Create with AI" button that every authorable
 * section carries in the same place. All this decides is WHICH task (none, for
 * `workflow` and `memory`) — the verb, the placeholder, the icon and the run
 * settings all come from that task's catalog entry.
 */
import { useState } from "react";
import { FileCog, Plus, SquarePen, Trash2 } from "lucide-react";
import {
  AGENT_TASKS,
  configTaskId,
  type ProjectConfig,
  type ProjectMemory,
} from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { TaskLauncherDialog } from "../tasks/TaskLauncherDialog.js";
import { taskIcon } from "../../lib/taskIcons.js";
import type { SectionDef } from "./sections.js";
import { deleteTarget, sectionItems } from "./configItems.js";

export function ConfigSectionPane({
  section,
  projectId,
  config,
  memories,
  busy,
  onOpenFile,
  onDelete,
  onLaunched,
  children,
}: {
  section: SectionDef;
  projectId: string | null;
  config: ProjectConfig | null;
  memories: ProjectMemory[];
  busy: boolean;
  /** Open a config-dir-relative file in the editor. */
  onOpenFile: (rel: string) => void;
  onDelete: (rel: string, label: string) => void;
  /** A task chat was spawned and focused — the host closes itself here. */
  onLaunched: () => void;
  /** Section-specific content rendered above the item list (the workflow editor). */
  children?: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const items = sectionItems(section.id, config, memories);
  const task = configTaskId(section.id);
  const Icon = section.icon;
  // The TASK's icon, not the section's: they agree today, and when they don't
  // it's the task icon that the spawned chat will wear.
  const TaskIcon = task ? taskIcon(AGENT_TASKS[task].icon) : Icon;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 [&_svg]:size-4">
          <Icon className="shrink-0 text-accent" />
          <h3 className="text-base font-semibold text-primary">{section.label}</h3>
          {/* Workflow isn't a list, so a count there would just read "0" forever. */}
          {section.countable !== false && (
            <Chip tone={items.length ? "accent" : "muted"} mono>
              {items.length}
            </Chip>
          )}
          {/* Every authorable section gets the same affordance in the same
              place, wearing its OWN task icon — the one the spawned chat will
              carry in the sidebar. Sections with no task (workflow, memory)
              simply don't have one, and an EMPTY section shows it in the empty
              state instead: two identical buttons in one pane read as two
              different actions. */}
          {task && items.length > 0 && (
            <Button
              variant="subtle"
              className="ml-auto"
              leftIcon={<TaskIcon />}
              disabled={busy || !projectId}
              onClick={() => setLaunching(true)}
            >
              Create with AI
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{section.explainer}</p>
      </div>

      {children}

      {/* The current contents. An empty section says what it would hold rather
          than showing a bare "0" — the old view's least useful pixel. */}
      {items.length > 0 ? (
        <ul className="divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-panel-2/40">
          {items.map((item) => {
            const target = deleteTarget(section.id, item);
            const armed = confirming === item.key;
            return (
              <li key={item.key} className="group flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-secondary">
                    {item.title}
                  </div>
                  {item.sub && (
                    <div className="truncate text-2xs text-faint">{item.sub}</div>
                  )}
                </div>
                {armed ? (
                  <>
                    <span className="text-2xs text-warn">Delete?</span>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        if (target) onDelete(target, item.title);
                      }}
                    >
                      Delete
                    </Button>
                  </>
                ) : (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {item.rel && (
                      <Button
                        variant="ghost"
                        leftIcon={<SquarePen />}
                        onClick={() => onOpenFile(item.rel!)}
                      >
                        Edit
                      </Button>
                    )}
                    {target && (
                      <Button
                        variant="ghost"
                        leftIcon={<Trash2 />}
                        onClick={() => setConfirming(item.key)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        section.id !== "workflow" && (
          <div className="rounded-md border border-dashed border-line px-3 py-5 text-center">
            <Icon className="mx-auto mb-1 size-4 text-faint" />
            <p className="text-xs text-secondary">
              No {section.noun}s in this project yet.
            </p>
            {/* The empty state is where the affordance matters most — this is
                the moment someone is looking for "how do I get one". */}
            {task && (
              <Button
                variant="primary"
                className="mt-2.5"
                leftIcon={<TaskIcon />}
                disabled={busy || !projectId}
                onClick={() => setLaunching(true)}
              >
                Create with AI
              </Button>
            )}
          </div>
        )
      )}

      {/* Describe-it, one dialog away. It used to sit inline under the list and
          take half the pane whether or not you wanted it; as a dialog it's out
          of the way until asked for, and gets real room when it isn't. */}
      {task && (
        <TaskLauncherDialog
          taskId={task}
          projectId={projectId}
          open={launching}
          onClose={() => setLaunching(false)}
          disabled={busy}
          onLaunched={onLaunched}
          secondary={
            // Only offered where it points somewhere real: these sections live
            // inside project.yaml, so "by hand" genuinely means editing it. A
            // file-backed section has no file to open until one exists.
            config && section.manifestBacked ? (
              <Button variant="ghost" leftIcon={<Plus />} onClick={() => onOpenFile("project.yaml")}>
                Edit project.yaml
              </Button>
            ) : undefined
          }
        />
      )}

      {section.id === "memory" && (
        <p className="flex items-start gap-1.5 text-2xs leading-snug text-faint [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
          <FileCog />
          Memories are written by agents as they work — open the Memory view in the sidebar to
          read, edit or prune them.
        </p>
      )}
    </div>
  );
}
