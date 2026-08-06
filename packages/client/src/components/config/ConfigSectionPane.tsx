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
 */
import { useState } from "react";
import { FileCog, Plus, Send, SquarePen, Sparkles, Trash2 } from "lucide-react";
import type { ProjectConfig, ProjectMemory } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import type { SectionDef } from "./sections.js";
import { deleteTarget, sectionItems } from "./configItems.js";

export function ConfigSectionPane({
  section,
  config,
  memories,
  busy,
  onOpenFile,
  onDelete,
  onAuthor,
  children,
}: {
  section: SectionDef;
  config: ProjectConfig | null;
  memories: ProjectMemory[];
  busy: boolean;
  /** Open a config-dir-relative file in the editor. */
  onOpenFile: (rel: string) => void;
  onDelete: (rel: string, label: string) => void;
  /** Hand a description to an agent; resolves when the chat has been spawned. */
  onAuthor: (description: string) => Promise<void>;
  /** Section-specific content rendered above the item list (the workflow editor). */
  children?: React.ReactNode;
}) {
  const [describe, setDescribe] = useState("");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const items = sectionItems(section.id, config, memories);
  const Icon = section.icon;

  async function submit() {
    const text = describe.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onAuthor(text);
      setDescribe("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 [&_svg]:size-4">
          <Icon className="shrink-0 text-accent" />
          <h3 className="text-[13px] font-semibold text-primary">{section.label}</h3>
          {/* Workflow isn't a list, so a count there would just read "0" forever. */}
          {section.countable !== false && (
            <Chip tone={items.length ? "accent" : "muted"} mono>
              {items.length}
            </Chip>
          )}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{section.explainer}</p>
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
                  <div className="truncate text-[11.5px] font-medium text-secondary">
                    {item.title}
                  </div>
                  {item.sub && (
                    <div className="truncate text-[10.5px] text-faint">{item.sub}</div>
                  )}
                </div>
                {armed ? (
                  <>
                    <span className="text-[10.5px] text-warn">Delete?</span>
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
            <p className="text-[11.5px] text-secondary">
              No {section.noun}s in this project yet.
            </p>
          </div>
        )
      )}

      {/* Describe-it: the way most of these get created. Deliberately below the
          list, so the pane reads "here's what you have" before "add more". */}
      {section.authorPlaceholder && (
        <div className="rounded-md border border-line bg-panel-2/40">
          <div className="flex items-center gap-2 px-3 py-2 [&_svg]:size-3.5">
            <Sparkles className="shrink-0 text-accent" />
            <span className="text-[11.5px] font-semibold text-primary">
              Add a {section.noun}
            </span>
            <span className="ml-auto truncate text-[10.5px] text-faint">
              describe it — an agent writes it
            </span>
          </div>
          <div className="space-y-2 border-t border-line-soft p-2.5">
            <textarea
              value={describe}
              onChange={(e) => setDescribe(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
              }}
              rows={3}
              placeholder={section.authorPlaceholder}
              disabled={sending}
              className={cn(
                "w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2",
                "text-[11.5px] leading-relaxed text-secondary placeholder:text-faint",
                "focus:border-accent-line focus:outline-none disabled:opacity-60",
              )}
            />
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-faint">
                Opens a chat here — it reads the repo first and you can steer it.
              </span>
              {/* Only offered where it points somewhere real: these sections live
                  inside project.yaml, so "by hand" genuinely means editing it.
                  A file-backed section has no file to open until one exists. */}
              {config && section.manifestBacked && (
                <Button
                  variant="ghost"
                  leftIcon={<Plus />}
                  onClick={() => onOpenFile("project.yaml")}
                >
                  Edit project.yaml
                </Button>
              )}
              <Button
                variant="primary"
                leftIcon={sending ? <Spinner size={12} /> : <Send />}
                disabled={!describe.trim() || sending || busy}
                onClick={() => void submit()}
              >
                Have Claude do it
              </Button>
            </div>
          </div>
        </div>
      )}

      {section.id === "memory" && (
        <p className="flex items-start gap-1.5 text-[10.5px] leading-snug text-faint [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
          <FileCog />
          Memories are written by agents as they work — open the Memory view in the sidebar to
          read, edit or prune them.
        </p>
      )}
    </div>
  );
}
