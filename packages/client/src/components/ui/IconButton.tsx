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

const sizes: Record<Size, string> = {
  sm: "size-6 [&_svg]:size-3.5",
  md: "size-7 [&_svg]:size-4",
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
            "hover:bg-white/[0.06] hover:text-primary disabled:pointer-events-none disabled:opacity-40",
          active && "bg-white/[0.07] text-primary",
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
