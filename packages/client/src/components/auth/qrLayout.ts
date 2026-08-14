import { encode } from "uqr";

/** The 4-module light border the spec requires; scanners fail without it. */
export const QUIET_ZONE = 4;

export interface QrLayout {
  /** Side length in modules, quiet zone included — the SVG viewBox. */
  size: number;
  /** `dark[y][x]` for the code itself, without the quiet zone. */
  dark: boolean[][];
  /** One `M…z` subpath per dark module, offset into the quiet zone. */
  path: string;
}

/** Encode a URI and lay it out for SVG, quiet zone included. */
export function qrLayout(uri: string): QrLayout {
  const { size, data } = encode(uri, { ecc: "M" });
  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y]![x]) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { size: size + QUIET_ZONE * 2, dark: data, path };
}
