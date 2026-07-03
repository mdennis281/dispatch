import { ChevronsUpDown, Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Popover, MenuItem } from "./Popover.js";

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
}: SelectProps<T>) {
  const current = options.find((o) => o.value === value);
  return (
    <Popover
      align={align}
      width={width}
      className="p-1"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 " +
              "text-[12px] font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary " +
              "[&_svg]:size-3.5",
            open && "border-line-strong text-primary",
            className,
          )}
        >
          {leftIcon && <span className="text-muted">{leftIcon}</span>}
          {label && <span className="text-faint">{label}</span>}
          <span className="text-primary">{current?.icon}</span>
          <span className="truncate">{current?.label ?? value}</span>
          <ChevronsUpDown className="ml-auto text-faint" />
        </button>
      )}
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
