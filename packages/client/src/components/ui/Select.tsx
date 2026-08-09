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
  /** Icon-only trigger; the label + current value move into a hover tooltip. */
  compact?: boolean;
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
  compact = false,
}: SelectProps<T>) {
  const current = options.find((o) => o.value === value);
  const tip = [label, current?.label ?? value].filter(Boolean).join(" · ");
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
            aria-label={compact ? tip : undefined}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-panel-2 " +
                "text-sm font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary " +
                "[&_svg]:size-3.5",
              compact ? "justify-center px-1.5" : "px-2",
              open && "border-line-strong text-primary",
              className,
            )}
          >
            {leftIcon && <span className="text-muted">{leftIcon}</span>}
            {!compact && (
              <>
                {label && <span className="text-faint">{label}</span>}
                <span className="text-primary">{current?.icon}</span>
                <span className="truncate">{current?.label ?? value}</span>
                <ChevronsUpDown className="ml-auto text-faint" />
              </>
            )}
            {compact && !leftIcon && <span className="text-primary">{current?.icon}</span>}
          </button>
        );
        return compact ? <Tooltip label={tip}>{btn}</Tooltip> : btn;
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
