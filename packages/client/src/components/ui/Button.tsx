import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * `link` and `toggle` exist because the panels kept hand-rolling them. Before
 * this, a "Cancel"/"Decline"/"pop out" text action was a raw `<button>` with a
 * one-off `text-[11px] text-muted hover:text-primary` in each of a dozen files,
 * and a pressed-state control was another `<button>` with its own idea of what
 * "on" looks like. Both are now one word at the call site, which is what makes
 * the no-raw-`<button>` lint rule (see eslint.config.js) a rule you can follow
 * rather than one you have to fight.
 */
type Variant = "default" | "primary" | "subtle" | "ghost" | "danger" | "link" | "toggle";
type Size = "xs" | "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium " +
  "transition-[background,border-color,color,box-shadow,transform] duration-150 " +
  "ease-[var(--ease-out)] select-none active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-45";

const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-[11px]",
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-8 px-3 text-[12.5px]",
};

const variants: Record<Variant, string> = {
  default:
    "bg-panel-2 text-primary border border-line hover:bg-elevated hover:border-line-strong",
  // `text-accent-fg`, never `text-white`: the accent is amber, and amber is a
  // light colour at every brightness that still reads as amber — white on it
  // never clears 4.5:1. The token is dark on the dark theme and light on the
  // light one, which a literal colour here could not be.
  primary:
    "bg-accent text-accent-fg border border-accent-line hover:bg-accent-hi " +
    "shadow-[inset_0_1px_0_0_var(--p-sheen)]",
  subtle:
    "bg-hover text-secondary border border-transparent hover:bg-active hover:text-primary",
  ghost:
    "bg-transparent text-secondary border border-transparent hover:bg-active hover:text-primary",
  danger:
    "bg-danger-ghost text-danger border border-transparent hover:bg-danger/20",
  // No box at all: a text action that must not compete with the real button
  // beside it (Cancel, Decline, "pop out"). Height still comes from `size`, so
  // it sits on the same baseline as the button it's declining.
  link:
    "bg-transparent text-muted border border-transparent px-1 hover:text-primary",
  // A control whose meaning is on/off. Drive it with `aria-pressed`, not a
  // className — the pressed look reads off the attribute, so the accessible
  // state and the visible state cannot drift apart.
  toggle:
    "bg-transparent text-muted border border-transparent hover:text-secondary " +
    "aria-pressed:bg-accent-ghost aria-pressed:text-accent-hi aria-pressed:border-accent-line",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "sm", leftIcon, rightIcon, className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cn(base, sizes[size], variants[variant], className)} {...rest}>
      {leftIcon && <span className="shrink-0 [&_svg]:size-3.5">{leftIcon}</span>}
      {children}
      {rightIcon && <span className="shrink-0 [&_svg]:size-3.5">{rightIcon}</span>}
    </button>
  );
});
