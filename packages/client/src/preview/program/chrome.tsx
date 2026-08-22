/**
 * Shared furniture for the program board — the bits every screen repeats.
 *
 * {@link Tunable} is the load-bearing one. The board is meant to become the
 * place concurrency limits, tool profiles and effort get CHANGED mid-run, and
 * a value that is going to be editable should not be rendered today as
 * unstyled text — the retrofit is what turns a clean screen into a patchwork.
 * So every such value goes through Tunable now: it renders as an affordance,
 * and when `onEdit` is wired it simply starts working.
 */
import type { ReactNode } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { cn } from "../../lib/cn.js";
import type { Tone } from "../../components/ui/index.js";
import { Chip } from "../../components/ui/index.js";
import type { ActorStatus, RunStatus, TaskStatus } from "./types.js";

/* ------------------------------------------------------------------ titles */

export function SectionTitle({
  icon,
  label,
  children,
  right,
}: {
  icon?: ReactNode;
  label: string;
  children?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
        {icon}
        {label}
      </span>
      <span className="text-2xs text-faint">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <span className="text-2xs italic text-faint">{children}</span>;
}

/* ------------------------------------------------------------- breadcrumbs */

export interface Crumb {
  label: string;
  onClick?: () => void;
}

/** Drill-in navigation. The back path is the crumb, not a browser button. */
export function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="flex min-w-0 items-center gap-1">
      {crumbs.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 shrink-0 text-faint" />}
          {c.onClick ? (
            <button
              type="button"
              onClick={c.onClick}
              className="truncate rounded px-1 py-0.5 text-xs text-muted transition-colors hover:bg-hover hover:text-primary"
            >
              {c.label}
            </button>
          ) : (
            <span className="truncate px-1 text-xs font-semibold text-primary">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------------- statuses */

const TASK_TONE: Record<TaskStatus, Tone> = {
  blocked: "muted",
  ready: "info",
  assigned: "info",
  running: "accent",
  "in-review": "warn",
  remediation: "warn",
  done: "success",
  failed: "danger",
  cancelled: "muted",
};

const ACTOR_TONE: Record<ActorStatus, Tone> = {
  idle: "muted",
  running: "accent",
  "waiting-human": "warn",
  blocked: "danger",
  retired: "muted",
};

const RUN_TONE: Record<RunStatus, Tone> = {
  draft: "muted",
  "awaiting-approval": "warn",
  running: "accent",
  paused: "warn",
  blocked: "danger",
  completed: "success",
  abandoned: "muted",
};

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  return <Chip tone={TASK_TONE[status]}>{status}</Chip>;
}

export function ActorStatusPill({ status }: { status: ActorStatus }) {
  return <Chip tone={ACTOR_TONE[status]}>{status}</Chip>;
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  return <Chip tone={RUN_TONE[status]}>{status}</Chip>;
}

/* ----------------------------------------------------------------- metrics */

/** One count on a card. `hint` is the unit; the number carries the emphasis. */
export function Metric({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: "default" | "warn" | "success" | "muted";
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "cm-mono text-sm leading-tight",
          tone === "warn"
            ? "text-warn"
            : tone === "success"
              ? "text-success"
              : tone === "muted"
                ? "text-faint"
                : "text-primary",
        )}
      >
        {value}
      </div>
      <div className="truncate text-[10px] leading-4 text-faint">{label}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- tunables */

/**
 * A value the human will be able to change from this page.
 *
 * Rendered as an affordance whether or not it is wired: a dashed underline and
 * a pencil that appears on hover. When `onEdit` is absent the control is inert
 * and says so on hover rather than looking broken — which is the honest state
 * today, and the one that does not require redesigning the row later.
 */
export function Tunable({
  value,
  label,
  onEdit,
}: {
  value: ReactNode;
  label: string;
  onEdit?: () => void;
}) {
  const wired = Boolean(onEdit);
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={!wired}
      title={wired ? `Change ${label}` : `${label} — editable once the engine lands`}
      className={cn(
        "group inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-px text-2xs transition-colors",
        wired
          ? "cursor-pointer border-line-strong text-secondary hover:border-accent-line hover:text-primary"
          : "cursor-default border-line text-muted",
      )}
    >
      <span className="text-[10px] leading-4 text-faint">{label}</span>
      <span className="font-medium">{value}</span>
      <Pencil
        className={cn(
          "size-2.5 transition-opacity",
          wired ? "opacity-0 group-hover:opacity-60" : "opacity-20",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------- context bar */

/** An actor's context fill against the recycle threshold. */
export function ContextBar({ fill, threshold }: { fill: number; threshold: number }) {
  const pct = Math.round(fill * 100);
  const over = fill >= threshold;
  return (
    <div className="flex items-center gap-1.5" title={`context ${pct}% · recycle at ${Math.round(threshold * 100)}%`}>
      <div className="relative h-1 w-14 overflow-hidden rounded-full bg-inset">
        <div
          className={cn("h-full rounded-full", over ? "bg-warn" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-line-strong"
          style={{ left: `${Math.round(threshold * 100)}%` }}
        />
      </div>
      <span className={cn("cm-mono text-[10px] leading-4", over ? "text-warn" : "text-faint")}>
        {pct}%
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- card shell */

export function Card({
  onClick,
  active,
  accent,
  className,
  children,
}: {
  onClick?: () => void;
  active?: boolean;
  /** Left rail colour — the owning team. */
  accent?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && e.key === "Enter" && onClick()}
      className={cn(
        "relative rounded-lg border bg-panel transition-colors",
        onClick && "cursor-pointer hover:border-line-strong",
        active ? "border-accent-line bg-accent-ghost" : "border-line",
        className,
      )}
    >
      {accent && (
        <span
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-full"
          style={{ background: accent }}
        />
      )}
      {children}
    </div>
  );
}
