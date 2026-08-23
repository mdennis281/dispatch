/**
 * Shared furniture for the mission board — the bits every screen repeats.
 *
 * {@link Tunable} is the load-bearing one. The board is meant to become the
 * place concurrency limits, tool profiles and effort get CHANGED mid-run, and
 * a value that is going to be editable should not be rendered today as
 * unstyled text — the retrofit is what turns a clean screen into a patchwork.
 * So every such value goes through Tunable now: it renders as an affordance,
 * and when `onEdit` is wired it simply starts working.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Home, Lock, Minus, Pencil, Plus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import type { Tone } from "../../components/ui/index.js";
import { Button, Chip, IconButton } from "../../components/ui/index.js";
import type { ActorStatus, RunStatus, TaskStatus } from "./types.js";
import type { SectionState } from "./sections.js";

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

/**
 * Drill-in navigation.
 *
 * Deliberately styled as CONTROLS rather than as a caption. The first version
 * was muted 11px text with a faint chevron, which read as a title telling you
 * where you were — so the way back was there, but nothing about it invited a
 * click. Ancestor crumbs are bordered, hoverable and full-contrast; only the
 * current level is plain text, because it is the one thing that is not a
 * destination.
 *
 * The current crumb is deliberately UNDEREMPHASISED. This strip sits under a
 * page title that already names where you are in full, so a bold restatement
 * here would make the loudest thing in the nav the one place you cannot go.
 */
export function Crumbs({ crumbs, onBack }: { crumbs: Crumb[]; onBack?: () => void }) {
  return (
    <nav className="flex min-w-0 items-center gap-1.5">
      {onBack && (
        <Button variant="default" size="sm" onClick={onBack} title="Up one level" leftIcon={<ArrowLeft />}>
          Back
        </Button>
      )}
      {crumbs.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted" />}
          {c.onClick ? (
            <Button
              variant="default"
              size="sm"
              onClick={c.onClick}
              className="shrink-0 truncate"
              leftIcon={i === 0 ? <Home /> : undefined}
            >
              {c.label}
            </Button>
          ) : (
            <span className="truncate px-1 text-xs font-medium text-secondary">{c.label}</span>
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
      <div className="truncate text-2xs leading-4 text-faint">{label}</div>
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
      <span className="text-2xs leading-4 text-faint">{label}</span>
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
      <span className={cn("cm-mono text-2xs leading-4", over ? "text-warn" : "text-faint")}>
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

/* ---------------------------------------------------------------- sections */

/**
 * A collapsible content section, indexed by the left rail.
 *
 * The header is a real toggle here AND a row in the sidebar, because the two
 * answer different questions: the sidebar is "what is on this screen and where
 * do I jump", the header is "I am done with this one". Both drive the same
 * state, so they can never disagree.
 */
export function Section({
  id,
  title,
  state,
  hint,
  right,
  children,
}: {
  id: string;
  title: string;
  state: SectionState;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  const open = state.isOpen(id);
  return (
    <section
      ref={(el) => state.register(id, el)}
      className="scroll-mt-2 border-b border-line-soft px-4 py-3 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => state.toggle(id)}
          className="group flex min-w-0 items-center gap-1.5 text-left"
        >
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-faint transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span className="text-xs font-semibold text-secondary group-hover:text-primary">
            {title}
          </span>
          {hint && <span className="truncate text-2xs text-faint">{hint}</span>}
        </button>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {open && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------ form inputs */

/** A labelled control row for the settings form. */
export function FormRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid items-start gap-x-3 gap-y-1 py-1.5 [grid-template-columns:11rem_minmax(0,1fr)]">
      <div className="pt-1">
        <div className="text-2xs font-medium text-primary">{label}</div>
        {help && <div className="mt-0.5 text-2xs leading-relaxed text-faint">{help}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A stepper for a bounded integer. Bounds are the schema's, not decoration. */
export function NumberInput({
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div className="inline-flex items-center gap-1">
      <div className="inline-flex items-center rounded-md border border-line bg-panel-2">
        <IconButton
          size="sm"
          onClick={() => onChange(clamp(value - 1))}
          disabled={value <= min}
          tip="Decrease"
          className="rounded-l-md rounded-r-none"
        >
          <Minus />
        </IconButton>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
          className="cm-mono w-10 border-x border-line bg-transparent py-0.5 text-center text-2xs text-primary outline-none [appearance:textfield] focus:bg-inset [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <IconButton
          size="sm"
          onClick={() => onChange(clamp(value + 1))}
          disabled={value >= max}
          tip="Increase"
          className="rounded-l-none rounded-r-md"
        >
          <Plus />
        </IconButton>
      </div>
      {suffix && <span className="text-2xs text-faint">{suffix}</span>}
      <span className="cm-mono text-2xs leading-4 text-faint">
        {min}–{max}
      </span>
    </div>
  );
}

/** A percentage slider, for the one setting that is genuinely continuous. */
export function PercentSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min * 100}
        max={max * 100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-inset accent-[var(--p-accent)]"
      />
      <span className="cm-mono text-2xs text-primary">{Math.round(value * 100)}%</span>
      <span className="cm-mono text-2xs leading-4 text-faint">
        {Math.round(min * 100)}–{Math.round(max * 100)}%
      </span>
    </div>
  );
}

/** A setting the schema pins. Shown, explained, and not editable. */
export function LockedRow({ value, why }: { value: ReactNode; why: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-md border border-warn-line bg-warn-ghost px-1.5 py-0.5 text-2xs text-warn">
        <Lock className="size-2.5" />
        {value}
      </span>
      <span className="flex-1 text-2xs leading-relaxed text-faint">{why}</span>
    </div>
  );
}

/**
 * A whole row that happens to be clickable — the drill-in board's dominant
 * interaction, and the reason this module is not full of bare button elements.
 *
 * `Button` and `IconButton` are the right primitives for an ACTION: they own
 * their height, padding and variant, which is exactly what makes them wrong
 * here. A navigation row owns none of those — it is a full-width, left-aligned,
 * often multi-line target whose layout IS the content (a title over a progress
 * bar, an icon beside two lines of status). Forcing it into a variant would
 * mean fighting the variant at every call site.
 *
 * So the answer the primitive kit wants is one bare element, wrapped once, in
 * place of the same bare element written out at fifteen call sites — see
 * `components/ui/rawButtons.test.ts`, which counts exactly that.
 */
export function RowButton({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("text-left transition-colors", className)}
      {...rest}
    >
      {children}
    </button>
  );
}
