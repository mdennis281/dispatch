import type { CSSProperties } from "react";
import {
  DISPATCH_MARK_BRANCHES,
  DISPATCH_MARK_NODES,
  DISPATCH_MARK_STROKE_WIDTH,
  DISPATCH_MARK_VIEW_BOX,
  dispatchBranchPath,
  type DispatchMarkPart as DispatchMarkPartName,
} from "../../brand/dispatchMark.js";
import "./DispatchMark.css";

export type { DispatchMarkPart } from "../../brand/dispatchMark.js";

const BRAND_AMBER = "#E5A33C";

export type DispatchMarkMotion = "branch" | "loading";
export type DispatchMarkColors = Partial<Record<DispatchMarkPartName, string>>;

export interface DispatchMarkProps {
  className?: string;
  /** Defaults to the brand amber. `currentColor` is useful in tinted controls. */
  color?: string;
  /** Per-part overrides keyed by semantic branch/node names. */
  colors?: DispatchMarkColors;
  /** Opt-in entrance or looping loading motion; static when omitted. */
  motion?: DispatchMarkMotion;
  /** Accessible name; omit for a decorative mark. */
  title?: string;
}

const BRANCH_DELAYS: Record<string, number> = {
  trunk: 0,
  upper: 180,
  lower: 300,
};

const NODE_DELAYS: Record<string, number> = {
  junction: 320,
  "upper-tip": 700,
  "lower-tip": 820,
};

type MarkStyle = CSSProperties & {
  "--dispatch-mark-color": string;
  "--dispatch-mark-stroke-width": number;
};

type PartStyle = CSSProperties & {
  "--dispatch-part-color"?: string;
  "--dispatch-part-delay": string;
};

function partStyle(color: string | undefined, delay: number): PartStyle {
  return {
    "--dispatch-part-color": color,
    "--dispatch-part-delay": `${delay}ms`,
  };
}

/**
 * Transparent, addressable Dispatch mark.
 *
 * Branches and nodes carry stable `data-part` names in the rendered SVG. Use
 * the typed `colors` prop for React-owned state; the attributes remain available
 * to CSS/Web Animations when a richer transition needs to choreograph the mark.
 */
export function DispatchMark({
  className,
  color = BRAND_AMBER,
  colors = {},
  motion,
  title,
}: DispatchMarkProps) {
  const style: MarkStyle = {
    "--dispatch-mark-color": color,
    "--dispatch-mark-stroke-width": DISPATCH_MARK_STROKE_WIDTH,
  };

  return (
    <svg
      viewBox={DISPATCH_MARK_VIEW_BOX}
      className={["dispatch-mark", className].filter(Boolean).join(" ")}
      data-motion={motion}
      style={style}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {DISPATCH_MARK_BRANCHES.map((branch) => (
        <path
          key={branch.id}
          className="dispatch-mark__branch"
          data-kind="branch"
          data-part={branch.id}
          d={dispatchBranchPath(branch)}
          pathLength={1}
          style={partStyle(colors[branch.id], BRANCH_DELAYS[branch.id] ?? 0)}
        />
      ))}
      {DISPATCH_MARK_NODES.map((node) => (
        <circle
          key={node.id}
          className="dispatch-mark__node"
          data-kind="node"
          data-part={node.id}
          cx={node.cx}
          cy={node.cy}
          r={node.radius}
          style={partStyle(colors[node.id], NODE_DELAYS[node.id] ?? 0)}
        />
      ))}
    </svg>
  );
}
