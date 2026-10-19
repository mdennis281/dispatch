/** Small pieces every section of the CI/CD page draws with. */
import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { CiConclusion, CiStatus } from "@dispatch/shared";
import { Spinner } from "../ui/Spinner.js";
import { RowButton } from "../ui/RowButton.js";
import { cn } from "../../lib/cn.js";
import { ciVisual } from "./ciModel.js";

/** A run/job/step's status as an icon; a spinner while it is running. */
export function CiStatusIcon({
  x,
  size = 14,
  className,
}: {
  x: { status: CiStatus; conclusion: CiConclusion | null };
  size?: number;
  className?: string;
}) {
  const v = ciVisual(x);
  if (v.spin) {
    return (
      <span className={cn("inline-flex shrink-0", v.color, className)} aria-label={v.label}>
        <Spinner size={size} />
      </span>
    );
  }
  return (
    <v.Icon
      aria-label={v.label}
      className={cn("shrink-0", v.color, className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Placeholder rows while a section's first load is in flight. */
export function CiSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <div className="size-3.5 shrink-0 animate-pulse rounded-full bg-panel-2" />
          <div className="flex-1 space-y-1.5">
            <div
              className="h-2.5 animate-pulse rounded bg-panel-2"
              // Uneven widths read as text; equal bars read as a broken table.
              style={{ width: `${[78, 62, 70, 54, 66][i % 5]}%` }}
            />
            <div className="h-2 w-1/3 animate-pulse rounded bg-panel-2/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A section's own failure. Inline, with a retry, and scoped to the section —
 * when there's stale data under it the caller renders this as a slim strip
 * ABOVE the data rather than instead of it.
 */
export function CiSectionError({
  message,
  onRetry,
  slim,
}: {
  message: string;
  onRetry?: () => void;
  slim?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md bg-danger-ghost text-danger",
        slim ? "px-2.5 py-1.5 text-2xs" : "px-3 py-2 text-xs",
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && (
        <RowButton
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline [&_svg]:size-3"
        >
          <RotateCw />
          Retry
        </RowButton>
      )}
    </div>
  );
}

/** A labelled block in the run detail (Jobs, Artifacts). */
export function CiSectionLabel({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">{children}</h3>
      {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
    </div>
  );
}
