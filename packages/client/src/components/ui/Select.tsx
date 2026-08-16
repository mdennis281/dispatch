import { ChevronsUpDown, Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Popover, MenuItem } from "./Popover.js";
import { Tooltip } from "./Tooltip.js";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

export interface SelectProps<T extends string> {
  options: SelectOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
  leftIcon?: ReactNode;
  className?: string;
  align?: "start" | "end";
  width?: number;
  /**
   * How much room the trigger is allowed to take (the composer's toolbar picks
   * this by measurement — see lib/composerFit):
   *   `lg` the full chip — `label` prefix, value, chevron
   *   `md` icon + value only; the prefix and chevron are the first things a
   *        cramped row can afford to lose, because the value is the point
   *   `sm` icon only, with everything else in the hover tooltip
   * Defaults to `lg`, which is every Select outside the composer.
   */
  size?: "lg" | "md" | "sm";
  /** Extra height for touch — the composer's phone row, where 24px is unhittable. */
  touch?: boolean;
}

/** A compact dropdown-select styled as a subtle chip button. */
export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
  leftIcon,
  className,
  align = "start",
  width = 180,
  size = "lg",
  touch = false,
}: SelectProps<T>) {
  const current = options.find((o) => o.value === value);
  const tip = [label, current?.label ?? value].filter(Boolean).join(" · ");
  const iconOnly = size === "sm";
  return (
    <Popover
      align={align}
      width={width}
      className="p-1"
      trigger={({ open, toggle }) => {
        const btn = (
          <button
            onClick={toggle}
            aria-expanded={open}
            aria-label={iconOnly ? tip : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2 " +
                "text-sm font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary " +
                "[&_svg]:size-3.5",
              touch ? "h-8" : "h-6",
              iconOnly ? "justify-center px-1.5" : "px-2",
              open && "border-line-strong text-primary",
              className,
            )}
          >
            {leftIcon && <span className="text-muted">{leftIcon}</span>}
            {!iconOnly && (
              <>
                {size === "lg" && label && <span className="text-faint">{label}</span>}
                <span className="text-primary">{current?.icon}</span>
                <span className="truncate">{current?.label ?? value}</span>
                {size === "lg" && <ChevronsUpDown className="ml-auto text-faint" />}
              </>
            )}
            {iconOnly && !leftIcon && <span className="text-primary">{current?.icon}</span>}
          </button>
        );
        // `md` keeps the tooltip too: it drops the "effort ·" prefix, so the
        // hover is the only thing left saying WHICH knob the value belongs to.
        return size === "lg" ? btn : <Tooltip label={tip}>{btn}</Tooltip>;
      }}
    >
      {(close) => (
        <div className="flex flex-col">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              icon={o.icon}
              hint={o.hint}
              active={o.value === value}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              <span className="flex items-center gap-2">
                {o.label}
                {o.value === value && <Check className="size-3 text-accent" />}
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}
