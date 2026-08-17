/**
 * Hex-colour normalisation for the Monaco theme bridge.
 *
 * Lives apart from `./setup` purely so it is testable: importing setup pulls in
 * the whole `monaco-editor` bundle and runs its bootstrap as a side effect.
 *
 * WHY THIS EXISTS AT ALL: Monaco's colour map is fed literal hex strings, and
 * `Color.fromHex` answers a string it cannot parse with **opaque red** rather
 * than an error. Its parser accepts only #RGB / #RGBA / #RRGGBB / #RRGGBBAA —
 * so a 6-character string is rejected outright. That is exactly what
 * `token("--p-wash") + "14"` produced in a PRODUCTION build: the CSS minifier
 * rewrites `--p-wash: #ffffff` to `#fff`, appending two alpha digits made
 * `#fff14`, and every wash-derived slot — both scrollbar sliders, the diff's
 * diagonal fill, the indent guides, the current-line highlight — painted
 * bright red. Never in dev, where the CSS is unminified and the token is still
 * seven characters. Expand shorthand BEFORE anything appends to it.
 */

/** `#abc` → `#aabbcc`, `#abcd` → `#aabbccdd`; anything else is returned as-is. */
export function expandHex(hex: string): string {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(hex);
  if (!m) return hex;
  const [, r, g, b, a] = m;
  return `#${r}${r}${g}${g}${b}${b}${a ? a + a : ""}`;
}

/** True only for the two forms Monaco's parser accepts once expanded. */
export function isMonacoHex(hex: string): boolean {
  return /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex);
}

/**
 * Normalise a raw CSS token value into a hex Monaco will parse, or `fallback`
 * if it is not a hex colour at all (an `rgba()` token, an empty string from a
 * missing variable). The fallback is deliberately garish — a slot that silently
 * fell back to vs-dark's own colour is a much more confusing failure than one
 * that is obviously wrong.
 */
export function normalizeHex(value: string, fallback = "#ff00ff"): string {
  const expanded = expandHex(value.trim());
  return isMonacoHex(expanded) ? expanded : fallback;
}

/**
 * Replace (not append) the alpha channel of a normalised hex. Taking the first
 * seven characters is what makes this safe for a token that already carries
 * alpha: appending would yield an 11-character string Monaco also rejects.
 */
export function withAlphaHex(hex: string, alpha: string): string {
  return hex.slice(0, 7) + alpha;
}
