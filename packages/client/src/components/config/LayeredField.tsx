/**
 * One field of a LAYERED setting in a settings pane.
 *
 * A layered setting has a value at this pane's layer OR inherits the one from
 * the layer beneath (the project pane inherits from the app; a chat control
 * inherits from the project, then the app). The control itself always shows
 * the EFFECTIVE value — a select over the resolved answer, not a blank chip
 * that means "unset" — and this wrapper adds the two things every such field
 * needs and every bespoke one forgot at least one of:
 *
 *   - a line saying where the value came from ("Inheriting High from your app
 *     settings" / "Set for this project"), fed by the resolver's `source`
 *   - a way BACK to inheriting, as reachable as the way to pin
 *
 * `ShellFilterPanel`'s `parentLabel` did this for one field; this is that
 * pattern for the rest, so the project pane's harness/mode/effort/model/
 * injected-context/auto-approve fields all read and reset the same way.
 */
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { layerSourceLabel, type LayerSource } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/cn.js";

export interface LayeredFieldProps {
  label: ReactNode;
  /** The one-line "what does this do" under the label. */
  description?: ReactNode;
  /** True when THIS layer pins the value (the reset affordance shows). */
  pinned: boolean;
  /** Where the effective value comes from, from the resolver. */
  source: LayerSource;
  /** Human reading of what is inherited if the pin is cleared, e.g. "High". */
  inheritedLabel: string;
  /** Which layer that inherited value comes from. */
  inheritedSource: LayerSource;
  /** The control, rendered over the effective value. */
  children: ReactNode;
  onReset: () => void;
  disabled?: boolean;
  className?: string;
}

export function LayeredField({
  label,
  description,
  pinned,
  source,
  inheritedLabel,
  inheritedSource,
  children,
  onReset,
  disabled,
  className,
}: LayeredFieldProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-secondary">{label}</div>
        {description && (
          <p className="mt-0.5 text-2xs leading-snug text-faint">{description}</p>
        )}
        {/* The provenance line. Pinned: say so, and offer the way back with
            what it leads to. Inherited: name the layer, so "why is this High"
            has its answer on the same row as the control. */}
        <div className="mt-1 flex min-h-5 items-center gap-2 text-2xs text-muted">
          {pinned ? (
            <>
              <span>Set for this project.</span>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RotateCcw />}
                disabled={disabled}
                onClick={onReset}
                title={`Inherit ${inheritedLabel} ${layerSourceLabel(inheritedSource)}`}
              >
                Inherit {inheritedLabel}
              </Button>
            </>
          ) : (
            <span>
              Inheriting <span className="font-medium text-secondary">{inheritedLabel}</span>{" "}
              {layerSourceLabel(source)}.
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
