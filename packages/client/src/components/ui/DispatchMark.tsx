/**
 * The Dispatch mark: a trunk splitting into two roads at a switch point.
 *
 * THIRD copy of this geometry, and the duplication is deliberate — the other two
 * can't be shared with React. `public/favicon.svg` is a static file the browser
 * fetches before any JS runs, and `scripts/generate-brand.mjs` renders it as a
 * signed-distance field so every PWA icon is a true render at its own size
 * rather than a resample. All three author in the same 64-unit box, so the
 * numbers below are the numbers there. **Change one, change all three**, or the
 * tab icon, the installed app icon and the top bar drift apart.
 *
 * Three forms:
 *   - default — the full app icon (dark rounded square + amber mark), i.e. what
 *     the taskbar and the browser tab show. Use it where the app identifies
 *     ITSELF, so the thing in the top-left is recognizably the thing you
 *     launched.
 *   - `bare` — strokes only, in `currentColor`. For placements that are already
 *     inside a tinted chip and want the surrounding text colour instead.
 *   - `platedTheme` — brand amber strokes, but the plate follows the theme's
 *     elevated surface. For in-app chrome on a LIGHT theme, where the icon's
 *     near-black plate stops reading as an app icon and starts reading as a
 *     hole punched in the header. The amber is untouched, so the mark is still
 *     the mark; only the square it sits on joins the room it's in.
 */

/*
 * Hardcoded on purpose, and exempt from the theme sweep: the mark is the BRAND,
 * so it must be identical in the tab icon, the installed app icon and the top
 * bar — including on a light theme, where a token-driven amber would darken and
 * the top bar would stop matching the taskbar. `theme/dark.css` carries the same
 * two values as `--p-brand` / `--p-brand-plate` so UI chrome can match the mark;
 * that token reads FROM here, never the other way round.
 */
const BG = "#14171B";
const FG = "#E5A33C";

export function DispatchMark({
  className,
  bare,
  platedTheme,
  title,
}: {
  className?: string;
  /** Strokes only, in currentColor — no plate, no brand amber. */
  bare?: boolean;
  /** Brand amber strokes on a theme-coloured plate (see the note above). */
  platedTheme?: boolean;
  /** Accessible name; omit for a purely decorative mark. */
  title?: string;
}) {
  const stroke = bare ? "currentColor" : FG;
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {!bare && (
        <rect
          x="1.9"
          y="1.9"
          width="60.2"
          height="60.2"
          rx="14.1"
          fill={platedTheme ? "var(--color-elevated)" : BG}
        />
      )}
      <g fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round">
        <path d="M12 32 H28" />
        <path d="M28 32 C37 32 39 24.08 50 21" />
        <path d="M28 32 C37 32 39 39.92 50 43" />
      </g>
      <g fill={stroke}>
        <circle cx="28" cy="32" r="2.9" />
        <circle cx="50" cy="21" r="3.3" />
        <circle cx="50" cy="43" r="3.3" />
      </g>
    </svg>
  );
}
