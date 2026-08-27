/**
 * The Dispatch mark in one data model shared by React and the asset renderer.
 *
 * Keeping the geometry as named branches and nodes is what makes the mark useful
 * beyond branding: a status surface can color a single worktree, and a loading
 * surface can reveal the graph in source-control order without knowing SVG path
 * details. `scripts/generate-brand.mjs` consumes these same coordinates, so the
 * installed icon cannot drift from the live component.
 */

export type DispatchBranchId = "trunk" | "upper" | "lower";
export type DispatchNodeId = "junction" | "upper-tip" | "lower-tip";
export type DispatchMarkPart = DispatchBranchId | DispatchNodeId;

type Point = readonly [x: number, y: number];

export type DispatchBranch =
  | { readonly id: DispatchBranchId; readonly kind: "line"; readonly points: readonly [Point, Point] }
  | {
      readonly id: DispatchBranchId;
      readonly kind: "cubic";
      readonly points: readonly [Point, Point, Point, Point];
    };

export interface DispatchNode {
  readonly id: DispatchNodeId;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

export const DISPATCH_MARK_VIEW_BOX = "0 0 64 64";
export const DISPATCH_MARK_STROKE_WIDTH = 4.5;

export const DISPATCH_MARK_BRANCHES: readonly DispatchBranch[] = [
  { id: "trunk", kind: "line", points: [[12, 32], [36, 32]] },
  { id: "upper", kind: "cubic", points: [[36, 32], [42, 32], [43, 22], [52, 20]] },
  { id: "lower", kind: "cubic", points: [[36, 32], [42, 32], [43, 42], [52, 44]] },
] as const;

export const DISPATCH_MARK_NODES: readonly DispatchNode[] = [
  { id: "junction", cx: 36, cy: 32, radius: 3.5 },
  { id: "upper-tip", cx: 52, cy: 20, radius: 3.5 },
  { id: "lower-tip", cx: 52, cy: 44, radius: 3.5 },
] as const;

export function dispatchBranchPath(branch: DispatchBranch): string {
  if (branch.kind === "line") {
    const [start, end] = branch.points;
    return `M${start[0]} ${start[1]}L${end[0]} ${end[1]}`;
  }
  const [start, controlA, controlB, end] = branch.points;
  return `M${start[0]} ${start[1]}C${controlA[0]} ${controlA[1]} ${controlB[0]} ${controlB[1]} ${end[0]} ${end[1]}`;
}
