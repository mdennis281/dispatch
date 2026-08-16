/**
 * One shape, drawn. Every node is positioned in image space and lives inside a
 * layer that carries the viewport transform, so nothing in here knows or cares
 * about the current zoom.
 *
 * `listening` is driven from the tool: while a drawing tool is active the shapes
 * must be transparent to hit detection, otherwise starting a stroke on top of an
 * existing arrow selects the arrow instead of drawing.
 */
import { Arrow, Ellipse, Line, Rect, Text } from "react-konva";
import type { Shape } from "./doc.js";

/**
 * Highlighter opacity. Multiply blending keeps the underlying screenshot legible
 * through the stroke, which is the entire point of a highlighter — a plain
 * translucent overlay greys out the text it is meant to draw attention to.
 */
const HIGHLIGHT_OPACITY = 0.45;

/** Arrow head size relative to stroke width, tuned to stay visible when thin. */
const HEAD = 3.2;

export interface ShapeNodeProps {
  shape: Shape;
  listening: boolean;
}

export function ShapeNode({ shape: s, listening }: ShapeNodeProps) {
  const common = { id: s.id, listening, perfectDrawEnabled: false };

  switch (s.kind) {
    case "pen":
      return (
        <Line
          {...common}
          points={s.points}
          stroke={s.color}
          strokeWidth={s.width}
          lineCap="round"
          lineJoin="round"
          tension={0.35}
          hitStrokeWidth={Math.max(s.width, 16)}
        />
      );
    case "highlight":
      return (
        <Line
          {...common}
          points={s.points}
          stroke={s.color}
          strokeWidth={s.width}
          lineCap="round"
          lineJoin="round"
          opacity={HIGHLIGHT_OPACITY}
          globalCompositeOperation="multiply"
          hitStrokeWidth={Math.max(s.width, 16)}
        />
      );
    case "arrow":
      return (
        <Arrow
          {...common}
          points={[s.x1, s.y1, s.x2, s.y2]}
          stroke={s.color}
          fill={s.color}
          strokeWidth={s.width}
          pointerLength={s.width * HEAD}
          pointerWidth={s.width * HEAD}
          lineCap="round"
          hitStrokeWidth={Math.max(s.width, 16)}
        />
      );
    case "rect":
      return (
        <Rect
          {...common}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          stroke={s.color}
          strokeWidth={s.width}
          cornerRadius={Math.min(s.width, 4)}
          // A hollow box must still be grabbable by its middle, or selecting one
          // means hitting a 4px outline.
          fillEnabled={false}
          hitFunc={(ctx, node) => {
            ctx.beginPath();
            ctx.rect(0, 0, s.w, s.h);
            ctx.closePath();
            ctx.fillStrokeShape(node);
          }}
        />
      );
    case "ellipse":
      return (
        <Ellipse
          {...common}
          x={s.x + s.w / 2}
          y={s.y + s.h / 2}
          radiusX={Math.abs(s.w / 2)}
          radiusY={Math.abs(s.h / 2)}
          stroke={s.color}
          strokeWidth={s.width}
          fillEnabled={false}
          hitFunc={(ctx, node) => {
            ctx.beginPath();
            ctx.ellipse(0, 0, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
            ctx.closePath();
            ctx.fillStrokeShape(node);
          }}
        />
      );
    case "redact":
      // Opaque by design: a blur can be reversed by anyone with the patience,
      // and this exists so a token or a customer name never reaches the model.
      return <Rect {...common} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.color} />;
    case "text":
      return (
        <Text
          {...common}
          x={s.x}
          y={s.y}
          text={s.text}
          fill={s.color}
          fontSize={s.fontSize}
          fontStyle="600"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          // A hairline of the opposite tone keeps light text readable on a light
          // screenshot without asking the user to think about contrast.
          stroke="rgba(0,0,0,0.55)"
          strokeWidth={Math.max(1, s.fontSize / 16)}
          fillAfterStrokeEnabled
        />
      );
    default:
      return null;
  }
}
