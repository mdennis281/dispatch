/**
 * Which locations the AGENT may pick per terminal — app `terminalLocations`,
 * overridden whole by project.yaml `defaults.terminalLocations`.
 *
 * A checkbox list rather than a Select because it is a SET, and because what
 * matters is how many: fewer than two and the agent has no choice at all (the
 * tool doesn't even offer `location`), which the summary line says outright
 * instead of leaving a lone ticked "This machine" to imply otherwise.
 *
 * Offered only when a plugin has registered a backend (see
 * {@link offerTerminalLocations}) — with none, `local` is the only place a
 * shell can run and a list of one is noise. A list that still names a backend
 * whose plugin is gone keeps showing, so the stale entry can be seen and
 * cleared.
 */
import { Check, RotateCcw } from "lucide-react";
import { LOCAL_TERMINAL_BACKEND, type TerminalBackendInfo } from "@dispatch/shared";
import { useTerminals } from "../../stores/terminals.js";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/cn.js";

/** Whether the control is worth rendering: a backend exists, or the list names one. */
export function offerTerminalLocations(
  backends: readonly TerminalBackendInfo[],
  ...lists: (readonly string[] | undefined)[]
): boolean {
  return backends.length > 0 || lists.some((l) => l?.some((id) => id !== LOCAL_TERMINAL_BACKEND));
}

export function TerminalLocationsPicker({
  value,
  inherited,
  parentLabel,
  onChange,
  disabled,
}: {
  /** This layer's list; `undefined` inherits `inherited`. */
  value: string[] | undefined;
  /** What applies beneath this layer (`[]` at the bottom). */
  inherited: string[];
  /** Names the layer beneath ("app settings"); without one there is no inherit affordance. */
  parentLabel?: string;
  /** `undefined` = inherit (or, at the bottom layer, unset). */
  onChange: (next: string[] | undefined) => void;
  disabled?: boolean;
}) {
  const backends = useTerminals((s) => s.backends);
  const effective = value ?? inherited;
  const enabled = new Set(effective);
  const rows: { id: string; label: string; hint?: string }[] = [
    { id: LOCAL_TERMINAL_BACKEND, label: "This machine", hint: "the Dispatch host" },
    ...backends.map((b) => ({ id: b.id, label: b.label, hint: b.pluginId })),
    // Named but not registered: still part of the answer, and the only place
    // to see it and untick it.
    ...effective
      .filter((id) => id !== LOCAL_TERMINAL_BACKEND && !backends.some((b) => b.id === id))
      .map((id) => ({ id, label: id, hint: "not installed" })),
  ];
  const toggle = (id: string) => {
    const next = new Set(effective);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Keep the rows' order, so the same set always saves as the same list.
    onChange(rows.map((r) => r.id).filter((r) => next.has(r)));
  };
  // The server offers each chat its DEFAULT on top of this list, and this
  // pane has no chat to know that default from. So a lone ticked backend is
  // still a choice (it plus a local default), and only an empty list — or a
  // lone `local` in a chat that defaults to local — is truly none. Counting
  // ticked rows and calling one "no choice" contradicted the Terminals panel
  // for the same config (review on #452).
  const offered = rows.filter((r) => enabled.has(r.id) && r.hint !== "not installed").map((r) => r.label);
  const reading =
    offered.length === 0
      ? "no choice — every terminal goes where the chat's default sends it"
      : offered.length === 1 && enabled.has(LOCAL_TERMINAL_BACKEND)
        ? "this machine on top of each chat's default — a choice only in chats that default to a backend"
        : `${offered.join(" · ")}, plus each chat's default`;
  const summary =
    value === undefined && parentLabel
      ? `Inheriting ${parentLabel}: ${reading}.`
      : `${reading.charAt(0).toUpperCase()}${reading.slice(1)}.`;

  return (
    <div>
      <div className="mb-2 flex min-h-6 items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted">{summary}</p>
        {value !== undefined && parentLabel && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw />}
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            Use {parentLabel}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          // At the bottom layer "off" is simply unset; above it, `[]` is the
          // pin that switches off a choice the layer beneath turned on.
          onClick={() => onChange(parentLabel ? [] : undefined)}
        >
          Off
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-inset/45">
        {rows.map((row) => {
          const checked = enabled.has(row.id);
          return (
            <Button
              key={row.id}
              type="button"
              variant="ghost"
              role="checkbox"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => toggle(row.id)}
              className="!flex !h-auto w-full justify-start gap-2.5 !whitespace-normal !rounded-none border-x-0 border-t-0 border-b border-line-soft px-2.5 py-2 text-left !font-normal last:border-b-0 hover:bg-hover/35 active:translate-y-0"
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border transition-colors [&_svg]:size-3",
                  checked ? "border-accent-line bg-accent-dim text-accent-hi" : "border-line-strong bg-panel text-transparent",
                )}
              >
                <Check />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-xs font-medium", checked ? "text-secondary" : "text-muted")}>
                  {row.label}
                </span>
                <span className="block truncate text-2xs text-faint">
                  <span className="cm-mono">{row.id}</span>
                  {row.hint ? ` · ${row.hint}` : ""}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
