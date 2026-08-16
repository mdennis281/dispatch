/**
 * The crop frame: a dimmed surround, a rule-of-thirds grid and four corner grips.
 *
 * Drawn in image space inside the same transformed layer as everything else, so
 * the frame tracks the picture exactly while zooming. Anything that must stay a
 * constant SIZE on screen — grip length, line thickness — is divided by the
 * viewport scale, because the layer's transform would otherwise magnify the
 * grips along with the pixels and leave them unusably huge at 8×.
 */
import { Group, Line, Rect } from "react-konva";
import type { Rect as RectShape } from "./doc.js";

/** On-screen sizes, in CSS pixels, before the scale compensation. */
const GRIP_LEN = 20;
const GRIP_THICK = 3;
const EDGE = 1;

export interface CropOverlayProps {
  crop: RectShape;
  imageWidth: number;
  imageHeight: number;
  scale: number;
  accent: string;
}

export function CropOverlay({ crop, imageWidth, imageHeight, scale, accent }: CropOverlayProps) {
  const grip = GRIP_LEN / scale;
  const thick = GRIP_THICK / scale;
  const edge = EDGE / scale;
  const dim = "rgba(0,0,0,0.55)";

  const { x, y, w, h } = crop;
  const corners: [number, number, number, number][] = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x + w, y + h, -1, -1],
    [x, y + h, 1, -1],
  ];

  return (
    <Group listening={false}>
      {/* Surround, as four bands rather than an even-odd path — simpler to reason
          about and it never mis-fills when the crop touches an edge. */}
      <Rect x={0} y={0} width={imageWidth} height={y} fill={dim} />
      <Rect x={0} y={y + h} width={imageWidth} height={Math.max(0, imageHeight - y - h)} fill={dim} />
      <Rect x={0} y={y} width={x} height={h} fill={dim} />
      <Rect x={x + w} y={y} width={Math.max(0, imageWidth - x - w)} height={h} fill={dim} />

      <Rect x={x} y={y} width={w} height={h} stroke={accent} strokeWidth={edge} />

      {/* thirds guides — the reason anyone eyeballs a crop rather than typing numbers */}
      {[1, 2].map((i) => (
        <Line
          key={`v${i}`}
          points={[x + (w * i) / 3, y, x + (w * i) / 3, y + h]}
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={edge}
        />
      ))}
      {[1, 2].map((i) => (
        <Line
          key={`h${i}`}
          points={[x, y + (h * i) / 3, x + w, y + (h * i) / 3]}
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={edge}
        />
      ))}

      {/* L-shaped grips, drawn inside the frame so they never overhang the image */}
      {corners.map(([cx, cy, sx, sy], i) => (
        <Group key={i}>
          <Rect x={cx - (sx < 0 ? grip : 0)} y={cy - (sy < 0 ? thick : 0)} width={grip} height={thick} fill={accent} />
          <Rect x={cx - (sx < 0 ? thick : 0)} y={cy - (sy < 0 ? grip : 0)} width={thick} height={grip} fill={accent} />
        </Group>
      ))}
    </Group>
  );
}
