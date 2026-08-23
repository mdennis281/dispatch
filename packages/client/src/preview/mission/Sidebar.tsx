/**
 * The left rail — navigation for the board, and the index of the current
 * screen's sections.
 *
 * It does three jobs, and the middle one is why it exists at all:
 *
 *   1. It shows how a Mission reads in the chats list, so "visually distinct
 *      from a quick action" can be judged by COMPARISON rather than asserted.
 *      A quick action already has a custom icon and a tint, so an icon alone is
 *      not an answer; a mission adds a filled badge, the accent-2 hue nothing
 *      else in the roster uses, a completion bar no other chat kind has, and
 *      actor chats nested underneath.
 *   2. It IS the navigation. Mission, phases, the tasks inside a phase, and
 *      every actor are rows here, and the selected row is the screen you are
 *      looking at. An earlier version of this rail was a decorative mock beside
 *      a board that navigated by clicking cards, which meant two unrelated ways
 *      to get anywhere and a rail that never agreed with the content.
 *   3. It indexes the current screen's sections and collapses them. A collapsed
 *      section keeps its row here, which is the only thing that makes it
 *      reopenable.
 */
import { useState } from "react";
import {
  ChevronDown,
  Crown,
  Eye,
  EyeOff,
  HardHat,
  Home,
  MessageSquare,
  SearchCheck,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { RowButton } from "./chrome.js";
import { phaseCounts, type Plan } from "./derive.js";
import type { Nav, Route } from "./nav.js";
import { SECTIONS, type SectionState } from "./sections.js";

export function Sidebar({
  plan,
  nav,
  sections,
}: {
  plan: Plan;
  nav: Nav;
  sections: SectionState;
}) {
  const { spec, run } = plan;
  const route = nav.route;
  const activePhase =
    route.at === "phase"
      ? route.phaseId
      : route.at === "task"
        ? plan.tasks.find((t) => t.id === route.taskId)?.phaseId
        : undefined;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    [run?.currentPhaseId ?? ""]: true,
  });
  const isExpanded = (id: string) => expanded[id] ?? id === activePhase;

  const done = plan.tasks.filter((t) => run?.tasks[t.id]?.status === "done").length;
  const pct = Math.round((done / plan.tasks.length) * 100);
  const live = (run?.actors ?? []).filter((a) => a.status !== "retired");
  const retired = (run?.actors ?? []).filter((a) => a.status === "retired");
  const defs = SECTIONS[route.at];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      {/* ------------------------------------------------ the chats list */}
      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <div className="mb-1 flex items-center gap-1 text-2xs uppercase leading-4 tracking-wide text-faint">
          chats <ChevronDown className="size-2.5" />
        </div>
        <div className="mb-1 flex gap-1">
          <TypeChip icon={<MessageSquare className="size-2.5" />} label="Chat" />
          <TypeChip icon={<Sparkles className="size-2.5" />} label="Quick" tint="accent" />
          <TypeChip icon={<Target className="size-2.5" />} label="Mission" filled />
        </div>
        <Row icon={<MessageSquare className="size-3" />} label="fix the viewport dead zone" />
        <Row
          icon={<Sparkles className="size-3" />}
          label="MCP server: add Linear"
          tint="text-accent"
        />
      </div>

      {/* --------------------------------------------------- the mission */}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <RowButton
          onClick={() => nav.go({ at: "mission" })}
          className={cn(
            "flex w-full items-start gap-1.5 rounded-md border px-1.5 py-1.5 text-left transition-colors",
            route.at === "mission"
              ? "border-accent-2-line bg-accent-2-ghost"
              : "border-transparent hover:bg-hover",
          )}
        >
          <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-accent-2 text-accent-2-fg">
            <Target className="size-2.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-2xs font-semibold text-primary">{spec.title}</span>
            <span className="mt-1 flex items-center gap-1">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-inset">
                <span
                  className="block h-full rounded-full bg-accent-2"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="cm-mono text-2xs leading-3 text-faint">{pct}%</span>
            </span>
          </span>
        </RowButton>

        {/* phases → tasks */}
        <Group label="Phases" icon={<Target className="size-2.5" />} />
        {[...spec.phases]
          .sort((a, b) => a.order - b.order)
          .map((p) => {
            const c = phaseCounts(plan, p.id);
            const status = run?.phases[p.id]?.status ?? "pending";
            const on = route.at === "phase" && route.phaseId === p.id;
            const open = isExpanded(p.id);
            const tasks = plan.tasks.filter((t) => t.phaseId === p.id);
            return (
              <div key={p.id}>
                <div
                  className={cn(
                    "group ml-2 flex items-center gap-1 rounded pr-1",
                    on ? "bg-accent-ghost" : "hover:bg-hover",
                  )}
                >
                  <RowButton
                    onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                    className="flex size-4 shrink-0 items-center justify-center text-faint hover:text-primary"
                  >
                    <ChevronDown
                      className={cn("size-2.5 transition-transform", !open && "-rotate-90")}
                    />
                  </RowButton>
                  <RowButton
                    onClick={() => nav.go({ at: "phase", phaseId: p.id })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
                  >
                    <span className="cm-mono text-2xs leading-3 text-faint">{p.order}</span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-xs leading-4",
                        on ? "font-medium text-primary" : "text-secondary",
                      )}
                    >
                      {p.title}
                    </span>
                    <StatusDotMini status={status} />
                    <span className="cm-mono shrink-0 text-2xs leading-3 text-faint">
                      {c.done}/{c.tasks}
                    </span>
                  </RowButton>
                </div>
                {open && (
                  <div className="ml-[1.35rem] border-l border-line pl-1">
                    {tasks.map((t) => {
                      const ts = run?.tasks[t.id]?.status ?? "blocked";
                      const sel = route.at === "task" && route.taskId === t.id;
                      return (
                        <RowButton
                          key={t.id}
                          onClick={() => nav.go({ at: "task", taskId: t.id })}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left",
                            sel ? "bg-accent-ghost" : "hover:bg-hover",
                          )}
                        >
                          <TaskDotMini status={ts} />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-2xs leading-4",
                              sel ? "text-primary" : "text-muted",
                            )}
                          >
                            {t.title}
                          </span>
                          {t.remediationRound !== undefined && (
                            <span className="cm-mono shrink-0 text-2xs leading-3 text-warn">
                              QA
                            </span>
                          )}
                        </RowButton>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

        {/* actors */}
        <Group label="Actors" icon={<Users className="size-2.5" />} />
        {[...live, ...retired].map((a) => {
          const sel = route.at === "agent" && route.actorId === a.id;
          return (
            <RowButton
              key={a.id}
              onClick={() => nav.go({ at: "agent", actorId: a.id })}
              className={cn(
                "ml-2 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded px-1 py-0.5 text-left",
                sel ? "bg-accent-ghost" : "hover:bg-hover",
                a.status === "retired" && "opacity-50",
              )}
            >
              <span className="shrink-0 text-faint">
                {a.kind === "orchestrator" ? (
                  <Crown className="size-2.5" />
                ) : a.kind === "qa" ? (
                  <SearchCheck className="size-2.5" />
                ) : a.kind === "lead" ? (
                  <Target className="size-2.5" />
                ) : (
                  <HardHat className="size-2.5" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs leading-4",
                  sel ? "text-primary" : "text-muted",
                )}
              >
                {a.name}
              </span>
              <ActorDotMini status={a.status} />
            </RowButton>
          );
        })}

        {/* The base of the tree. Everything above drills DOWN from here, so it
            sits at the bottom as the floor you land back on — and it is the one
            row that is a destination rather than a thing. */}
        <RowButton
          onClick={() => nav.go({ at: "mission" })}
          className={cn(
            "mt-3 flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-left transition-colors",
            route.at === "mission"
              ? "border-accent-2-line bg-accent-2-ghost text-primary"
              : "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary",
          )}
        >
          <Home className="size-3 shrink-0" />
          <span className="flex-1 text-xs font-medium leading-4">Mission Base</span>
          <span className="cm-mono text-2xs leading-3 text-faint">{pct}%</span>
        </RowButton>
      </div>

      {/* ------------------------------------------- sections, this screen */}
      <div className="shrink-0 border-t border-line px-2 py-2">
        <div className="mb-1 flex items-center gap-1">
          <span className="text-2xs uppercase leading-4 tracking-wide text-faint">
            on this screen
          </span>
          <RowButton
            onClick={() => {
              const allOpen = defs.every((d) => sections.isOpen(d.id));
              for (const d of defs) sections.setOpen(d.id, !allOpen);
            }}
            className="ml-auto rounded px-1 text-2xs leading-4 text-faint hover:bg-hover hover:text-primary"
          >
            {defs.every((d) => sections.isOpen(d.id)) ? "hide all" : "show all"}
          </RowButton>
        </div>
        {defs.map((d) => {
          const open = sections.isOpen(d.id);
          return (
            <div
              key={d.id}
              className={cn(
                "group flex items-center gap-1 rounded",
                sections.active === d.id ? "bg-accent-ghost" : "hover:bg-hover",
              )}
            >
              <RowButton
                onClick={() => sections.focus(d.id)}
                className={cn(
                  "min-w-0 flex-1 truncate px-1.5 py-0.5 text-left text-xs leading-4",
                  open ? "text-secondary" : "text-faint line-through",
                )}
              >
                {d.label}
              </RowButton>
              <RowButton
                onClick={() => sections.toggle(d.id)}
                title={open ? "Collapse" : "Expand"}
                className="flex size-5 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
              >
                {open ? <Eye className="size-2.5" /> : <EyeOff className="size-2.5" />}
              </RowButton>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- bits */

function Group({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-center gap-1 px-1 pb-0.5 text-2xs uppercase leading-4 tracking-wide text-faint">
      {icon}
      {label}
    </div>
  );
}

function TypeChip({
  icon,
  label,
  tint,
  filled,
}: {
  icon: React.ReactNode;
  label: string;
  tint?: "accent";
  filled?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1 py-px text-2xs leading-4",
        filled
          ? "border-accent-2-line bg-accent-2 font-semibold text-accent-2-fg"
          : tint === "accent"
            ? "border-line bg-panel-2 text-accent"
            : "border-line bg-panel-2 text-muted",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function Row({ icon, label, tint }: { icon: React.ReactNode; label: string; tint?: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md px-1 py-0.5">
      <span className={cn("shrink-0", tint ?? "text-faint")}>{icon}</span>
      <span className="truncate text-xs leading-4 text-muted">{label}</span>
    </div>
  );
}

function StatusDotMini({ status }: { status: string }) {
  return (
    <span
      title={status}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "done"
          ? "bg-success"
          : status === "running"
            ? "bg-accent"
            : status === "qa" || status === "gating"
              ? "bg-warn"
              : status === "blocked"
                ? "bg-danger"
                : "bg-line-strong",
      )}
    />
  );
}

function TaskDotMini({ status }: { status: string }) {
  return (
    <span
      title={status}
      className={cn(
        "size-1 shrink-0 rounded-full",
        status === "done"
          ? "bg-success"
          : status === "running"
            ? "bg-accent"
            : status === "ready"
              ? "bg-info"
              : status === "failed"
                ? "bg-danger"
                : "bg-line-strong",
      )}
    />
  );
}

function ActorDotMini({ status }: { status: string }) {
  return (
    <span
      title={status}
      className={cn(
        "size-1 shrink-0 rounded-full",
        status === "running"
          ? "bg-accent"
          : status === "waiting-human"
            ? "bg-warn"
            : status === "blocked"
              ? "bg-danger"
              : "bg-line-strong",
      )}
    />
  );
}
