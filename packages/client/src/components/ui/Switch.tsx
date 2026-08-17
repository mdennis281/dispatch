import { cn } from "../../lib/cn.js";

/**
 * A compact token-styled on/off switch.
 *
 * This used to be copy-pasted into `SettingsPanel` and `WorkflowProfilePicker`,
 * which was survivable while both lived in one modal each. Settings is now seven
 * separate section files, so a private copy per file would be seven chances for
 * the same control to drift.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-sm font-medium text-secondary disabled:opacity-50"
    >
      <span
        className={cn(
          "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent-line bg-accent-dim/80" : "border-line bg-inset",
        )}
      >
        <span
          className={cn(
            "absolute size-3 rounded-full bg-primary shadow transition-transform",
            checked ? "translate-x-[14px]" : "translate-x-[3px]",
          )}
        />
      </span>
      {label}
    </button>
  );
}
