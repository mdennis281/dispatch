import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Tooltip } from "./Tooltip.js";

type Size = "sm" | "md";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  active?: boolean;
  tip?: string;
  children: ReactNode;
}

// Square counterparts of Button's two heights — see the note there.
const sizes: Record<Size, string> = {
  sm: "size-6 [&_svg]:size-3.5",
  md: "size-8 [&_svg]:size-4",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ size = "sm", active, tip, className, children, ...rest }, ref) {
    const btn = (
      <button
        ref={ref}
        // An icon-only button's only label is its tooltip, and that lives in a
        // portal the button isn't associated with — so without this it has no
        // accessible name at all. An explicit aria-label in `rest` still wins.
        aria-label={tip}
        className={cn(
          "inline-flex items-center justify-center rounded-sm border border-transparent " +
            "text-secondary transition-colors duration-150 ease-[var(--ease-out)] " +
            "hover:bg-active hover:text-primary disabled:pointer-events-none disabled:opacity-40",
          // Selected is BRAND, not just "a bit brighter". `bg-selected` +
          // `text-primary` differed from the hover state by a few percent of
          // lightness, so on a phone — where the pressed button is under your
          // thumb — you couldn't tell which overlay was open. The amber matches
          // what the sidebar's NavButton and the bottom nav already do for the
          // same idea, so one colour means "current" everywhere in the shell.
          // `hover:` repeated because Tailwind emits hover variants after plain
          // utilities: without it the base `hover:text-primary` would win and
          // the selected button would drop its amber the moment you pointed at it.
          active && "bg-accent-ghost text-accent-hi hover:text-accent-hi",
          sizes[size],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
    return tip ? <Tooltip label={tip}>{btn}</Tooltip> : btn;
  },
);
