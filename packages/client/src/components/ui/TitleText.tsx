/**
 * A chat title, with its one piece of emphasis rendered.
 *
 * Titles may carry `**bold**` runs (see `@dispatch/shared/titles`) — a spawned
 * chat leads with its category, `**sweep**: 12 files on main`, and a human can
 * type the same thing in a rename. Those runs take the accent colour; everything
 * else is the caller's own text colour, inherited, so this drops into a sidebar
 * row and a page heading without either of them restyling it.
 *
 * Deliberately NOT a markdown renderer: a title is a label, and a label that can
 * grow links, code spans and headings is a layout bug waiting for someone to
 * paste the wrong thing into a rename box.
 */
import { useMemo } from "react";
import { parseTitleMarks } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";

export function TitleText({ title, className }: { title: string; className?: string }) {
  const segments = useMemo(() => parseTitleMarks(title), [title]);
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.accent ? (
          <span key={i} className="text-accent">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * The same, for a single-line container that truncates. Kept separate because
 * truncation needs the ellipsis on the OUTER element while the segments stay
 * inline — a caller that puts `truncate` on the segments gets three ellipses.
 */
export function TitleLine({ title, className }: { title: string; className?: string }) {
  return (
    <span className={cn("block min-w-0 truncate", className)}>
      <TitleText title={title} />
    </span>
  );
}
