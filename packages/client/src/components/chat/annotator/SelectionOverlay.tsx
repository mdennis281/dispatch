/**
 * Selection affordance for the shape under edit.
 *
 * Handles are named (`handle:nw`, `handle:p1`, …) rather than identified by
 * position, because the editor hit-tests with `stage.getIntersection` and reads
 * the name back — that keeps one hit-testing path for shapes and handles alike
 * instead of a second, screen-space rectangle check that has to be kept in sync
 * with wherever these ended up being drawn.
 *
 * Sizes are divided by the viewport scale for the same reason as the crop grips:
 * a handle is a piece of UI, not a piece of the picture, so it must not zoom.
 */
import { Circle, Group, Rect } from "react-konva";
import { isBox, type Shape, shapeBounds } from "./doc.js";

const HANDLE_R = 7;
const EDGE = 1;
/** Generous invisible padding — a 7px dot is a miss on a touchscreen. */
const TOUCH_R = 16;

export interface SelectionOverlayProps {
  shape: Shape;
  scale: number;
  accent: string;
}

export function SelectionOverlay({ shape, scale, accent }: SelectionOverlayProps) {
  const r = HANDLE_R / scale;
  const touch = TOUCH_R / scale;
  const edge = EDGE / scale;
  const b = shapeBounds(shape);

  const handles: { name: string; x: number; y: number }[] =
    shape.kind === "arrow"
      ? [
          { name: "handle:p1", x: shape.x1, y: shape.y1 },
          { name: "handle:p2", x: shape.x2, y: shape.y2 },
        ]
      : isBox(shape)
        ? [
            { name: "handle:nw", x: shape.x, y: shape.y },
            { name: "handle:ne", x: shape.x + shape.w, y: shape.y },
            { name: "handle:se", x: shape.x + shape.w, y: shape.y + shape.h },
            { name: "handle:sw", x: shape.x, y: shape.y + shape.h },
          ]
        : // Strokes and text have no resize handles: scaling a freehand path or
          // a font by dragging a corner produces a worse result than redrawing,
          // and the style row already changes their size.
          [];

  return (
    <Group>
      <Rect
        listening={false}
        x={b.x - r}
        y={b.y - r}
        width={b.w + r * 2}
        height={b.h + r * 2}
        stroke={accent}
        strokeWidth={edge}
        dash={[4 / scale, 4 / scale]}
      />
      {handles.map((h) => (
        <Circle
          key={h.name}
          name={h.name}
          x={h.x}
          y={h.y}
          radius={r}
          fill="#ffffff"
          stroke={accent}
          strokeWidth={edge * 2}
          hitStrokeWidth={touch}
        />
      ))}
    </Group>
  );
}
