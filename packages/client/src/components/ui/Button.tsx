import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";

type Variant = "default" | "primary" | "subtle" | "ghost" | "danger";
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
