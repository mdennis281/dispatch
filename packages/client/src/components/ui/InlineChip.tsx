import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * A chip that sits INSIDE a line of prose.
 *
 * Neither `Button` nor `IconButton` can be this: both start at `h-6`, and a
 * 24px box dropped into a paragraph pushes the line box open and makes the
 * surrounding text jump line to line. This has no height of its own — it is
 * `align-baseline` with `py-px`, so a sentence containing three of them still
 * has the leading of a sentence.
 *
 * It exists because there were about to be two of them. `codeRefs`' pointer
 * chip was a raw `<button>` with a long one-off class string; the media chip
 * added for image paths in prose was being written as a copy of it, differing
 * only in the icon. One primitive, so the two can't drift into looking like
 * different kinds of thing when they are the same kind of thing.
 */
export interface InlineChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Leading glyph — sized and dimmed to match the label, not to compete. */
  icon?: ReactNode;
  children: ReactNode;
}

export const InlineChip = forwardRef<HTMLButtonElement, InlineChipProps>(
  function InlineChip({ icon, children, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "inline-flex items-center gap-1 rounded-[4px] border border-accent-line/70 " +
            "bg-accent-ghost px-1 py-px align-baseline cm-mono !text-xs text-accent-hi " +
            "transition-colors hover:border-accent hover:bg-accent-ghost/80 " +
            "outline-none focus-visible:ring-1 focus-visible:ring-accent-line " +
            "[&_svg]:size-3 [&_svg]:-mb-px [&_svg]:opacity-80",
          className,
        )}
        {...rest}
      >
        {icon}
        {children}
      </button>
    );
  },
);
