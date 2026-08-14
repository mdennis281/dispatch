import { Check, RotateCcw } from "lucide-react";
import type { ShellTranscriptCategory, ShellTranscriptFilter } from "@dispatch/shared";
import { SHELL_FILTER_OPTIONS, normalizedShellFilter } from "../../lib/shellFilter.js";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/cn.js";

export function ShellFilterPanel({
  value,
  inherited,
  onChange,
  parentLabel,
}: {
  value: ShellTranscriptFilter | undefined;
  inherited: ShellTranscriptFilter;
  onChange: (value: ShellTranscriptFilter | undefined) => void;
  parentLabel?: string;
}) {
  const effective = value ?? inherited;
  const enabled = new Set(effective);
  const toggle = (category: ShellTranscriptCategory) => {
    const next = new Set(effective);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    onChange(normalizedShellFilter([...next]));
  };

  return (
    <div>
      <div className="mb-2 flex min-h-6 items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted">
          {value === undefined && parentLabel ? `Inheriting ${parentLabel}.` : `${effective.length} of ${SHELL_FILTER_OPTIONS.length} shown.`}
        </p>
        {value !== undefined && parentLabel && (
          <Button variant="ghost" size="sm" leftIcon={<RotateCcw />} onClick={() => onChange(undefined)}>
            Use {parentLabel}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onChange(normalizedShellFilter(SHELL_FILTER_OPTIONS.map((item) => item.id)))}>
          All
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange([])}>
          None
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-inset/45">
        {SHELL_FILTER_OPTIONS.map((option) => {
          const checked = enabled.has(option.id);
          return (
            <Button
              key={option.id}
              type="button"
              variant="ghost"
              role="checkbox"
              aria-checked={checked}
              onClick={() => toggle(option.id)}
              className="!flex !h-auto w-full justify-start gap-2.5 !whitespace-normal !rounded-none border-x-0 border-t-0 border-b border-line-soft px-2.5 py-2 text-left !font-normal last:border-b-0 hover:bg-hover/35 active:translate-y-0"
            >
              <span className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded border transition-colors [&_svg]:size-3",
                checked ? "border-accent-line bg-accent-dim text-accent-hi" : "border-line-strong bg-panel text-transparent",
              )}>
                <Check />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-xs font-medium", checked ? "text-secondary" : "text-muted")}>{option.label}</span>
                <span className="block truncate text-2xs text-faint">{option.description}</span>
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
