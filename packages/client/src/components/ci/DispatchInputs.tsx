/**
 * The `workflow_dispatch` input form, shared by the right panel's per-chat Run
 * popover and the CI/CD page's Run dialog — two entry points to one GitHub
 * feature, so one set of rules for defaults, required-ness and what gets sent.
 */
import { Check } from "lucide-react";
import type { WorkflowInput } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";

export const DISPATCH_FIELD =
  "h-7 w-full rounded-md border border-line bg-inset px-2 text-xs text-primary outline-none " +
  "placeholder:text-faint focus:border-line-strong";

/** Form values seeded from each input's declared default. */
export function seedInputValues(list: WorkflowInput[]): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const inp of list) {
    if (inp.type === "boolean") seed[inp.name] = inp.default ?? "false";
    else if (inp.type === "choice") seed[inp.name] = inp.default ?? inp.options?.[0] ?? "";
    else seed[inp.name] = inp.default ?? "";
  }
  return seed;
}

/** Required inputs still empty. A boolean is never "missing" — false is an answer. */
export function missingInputs(list: WorkflowInput[], values: Record<string, string>): WorkflowInput[] {
  return list.filter((i) => i.required && i.type !== "boolean" && !(values[i.name] ?? "").trim());
}

/**
 * What to send: booleans always (normalised), everything else only when
 * non-empty — an omitted input takes the workflow's own default, an empty
 * string overrides it with nothing.
 */
export function collectInputValues(
  list: WorkflowInput[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inp of list) {
    const v = values[inp.name] ?? "";
    if (inp.type === "boolean") out[inp.name] = v === "true" ? "true" : "false";
    else if (v.trim() !== "") out[inp.name] = v;
  }
  return out;
}

/** One labelled input, rendered by type. */
export function DispatchInputField({
  input,
  value,
  onChange,
  onEnter,
}: {
  input: WorkflowInput;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
        <span className="normal-case tracking-normal text-secondary">{input.name}</span>
        {input.required && <span className="text-danger">*</span>}
      </label>
      {input.description && (
        <span className="-mt-0.5 text-2xs leading-snug text-faint">{input.description}</span>
      )}
      {input.type === "boolean" ? (
        <button
          type="button"
          role="switch"
          aria-checked={value === "true"}
          onClick={() => onChange(value === "true" ? "false" : "true")}
          className={cn(
            "inline-flex h-6 w-fit items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
            value === "true"
              ? "border-accent-line bg-accent-ghost text-accent-hi"
              : "border-line bg-inset text-secondary hover:border-line-strong",
          )}
        >
          {value === "true" ? <Check className="size-3.5" /> : <span className="size-3.5" />}
          {value === "true" ? "true" : "false"}
        </button>
      ) : input.type === "choice" && input.options?.length ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(DISPATCH_FIELD, "cursor-pointer")}
        >
          {input.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
          placeholder={input.default || input.name}
          spellCheck={false}
          inputMode={input.type === "number" ? "numeric" : undefined}
          className={DISPATCH_FIELD}
        />
      )}
    </div>
  );
}
