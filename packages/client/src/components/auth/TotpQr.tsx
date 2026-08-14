import { useMemo } from "react";
import { qrLayout } from "./qrLayout.js";

/**
 * The otpauth URI as a scannable code. Drawn as SVG rects from the module
 * matrix rather than uqr's SVG string, so nothing goes through innerHTML.
 *
 * Black-on-white on purpose: a scanner reads dark-on-light, so this one block
 * stays light in dark mode rather than inheriting the theme and inverting.
 */
export function TotpQr({ uri, className }: { uri: string; className?: string }) {
  const { size, path } = useMemo(() => qrLayout(uri), [uri]);
  return <svg viewBox={`0 0 ${size} ${size}`} className={className} role="img"
    aria-label="Authenticator app setup QR code" shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#ffffff" />
    <path d={path} fill="#000000" />
  </svg>;
}
