/**
 * ToggleRow + OptionCard — the two shapes a settings pane is made of.
 *
 * Both shapes were invented in `WorkflowProfilePicker`: a switch with a title and
 * a paragraph of consequences, and a selectable card that reveals what picking it
 * actually does. The reviewer pane wanted exactly the same two — the moment a
 * copy becomes a divergence, because the second copy is where the padding
 * drifts, the disabled state gets forgotten, and the accent stops matching the
 * pane next to it.
 *
 * The picker deliberately still has its own private versions. Adopting these
 * there would be a visual change to a pane this work is not about, and the point
 * of extracting them now is that the NEXT pane doesn't start a third copy.
 * `SwitchTrack` therefore matches the picker's measurements exactly rather than
 * improving on them.
 *
 * They live in `ui/` because both are genuinely a bare `<button>`: the clickable
 * thing is the WHOLE ROW (or the whole card), and `Button` cannot be that without
 * giving up its height floor, its padding and its single-line layout — which is
 * the entire component. `ui/` is where that bare element is the primitive rather
 * than a bypass of it (see `rawButtons.test.ts`).
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * The switch's LOOK, with none of its behaviour — deliberately not `ui/Switch`.
 *
 * It always sits inside a row that is ITSELF the clickable control, so a real
 * switch here would be a nested interactive element: invalid markup, and two
 * overlapping hit targets for one decision. This is a plain span showing the
 * state its row toggles.
 *
 * The measurements are copied verbatim from `WorkflowProfilePicker`'s private
 * twin rather than rounded to the nearest Tailwind step, because the two sit on
 * adjacent pages of the same settings view and a switch that is one pixel
 * different on each is worse than either.
 */
export function SwitchTrack({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-accent-line bg-accent-dim/80" : "border-line bg-inset",
        disabled && "opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute size-3 rounded-full bg-primary shadow transition-transform",
          checked ? "translate-x-[14px]" : "translate-x-[3px]",
        )}
      />
    </span>
  );
}

/**
 * A switch, a title and the sentence that says what turning it on costs you.
 *
 * The description is not optional decoration: every setting this shape is used
 * for changes what an AGENT is allowed to do, and a bare label leaves the
 * consequence to be guessed at.
 */
export function ToggleRow({
  checked,
  onChange,
  title,
  icon,
  description,
  disabled,
  className,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  /** Sits before the title, and takes the accent colour when on. */
  icon?: ReactNode;
  description: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Revealed under the row when it's on — sub-settings that only apply then. */
  children?: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "flex w-full items-start gap-2 text-left disabled:opacity-60",
          className,
        )}
      >
        <SwitchTrack checked={checked} disabled={disabled} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
            {icon && <span className={checked ? "text-accent" : "text-muted"}>{icon}</span>}
            <span
              className={cn(
                "text-xs font-semibold",
                checked ? "text-accent" : "text-secondary",
              )}
            >
              {title}
            </span>
          </span>
          <span className="mt-0.5 block text-2xs leading-snug text-faint">{description}</span>
        </span>
      </button>
      {checked && children}
    </>
  );
}

/**
 * One choice in a row of them, which explains itself once chosen.
 *
 * The `effects` list is the point of the shape. These are settings where the
 * consequences ARE the decision — "review as a dedicated account" means nothing
 * until you know it can request changes and needs a collaborator invite — so the
 * selected card spends the space to say so rather than leaving it to a tooltip.
 */
export function OptionCard({
  selected,
  onSelect,
  label,
  icon,
  blurb,
  effects,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  icon?: ReactNode;
  blurb: string;
  /** Shown only while selected — what picking this actually does. */
  effects?: readonly string[];
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-60",
        selected
          ? "border-accent/50 bg-accent-ghost"
          : "border-line hover:border-line-strong hover:bg-panel-2",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 [&_svg]:size-3.5">
        {icon && <span className={selected ? "text-accent" : "text-muted"}>{icon}</span>}
        <span
          className={cn("text-xs font-semibold", selected ? "text-accent" : "text-secondary")}
        >
          {label}
        </span>
      </div>
      <p className="text-2xs leading-snug text-faint">{blurb}</p>
      {selected && effects && effects.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-line-soft pt-1.5">
          {effects.map((e) => (
            <li key={e} className="text-2xs leading-snug text-muted">
              • {e}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}
