/**
 * The filter row — one row, above everything it scopes.
 *
 * Every card below reads the same window and the same filter, so the controls
 * live here once rather than per-card: two charts side by side that could
 * disagree about their range is a dashboard whose numbers can't be compared,
 * which is the only thing a dashboard is for.
 *
 * Date range comes first because it's the control every reader reaches for, and
 * it's presets rather than a calendar — nobody wants to fight a date grid for
 * "last 30 days".
 *
 * The dimension filters are populated from the LEDGER (`facets`), not from the
 * projects/agents stores. A list that offered a project with no rows would be a
 * dead end, and one that dropped a DELETED project would hide history that
 * still exists.
 *
 * ---
 *
 * GENERIC OVER THE DIMENSION SET, because there are two ledgers. The usage half
 * filters by `category`; the runtime half filters by `state` and `class` and by
 * `runId`, and neither dimension exists in the other's table — a `state` chip
 * sent to `/api/metrics/facets` is a 400, not a narrower result. So the two
 * pages cannot share ONE filter row's state, and this file makes them share its
 * behaviour instead: {@link FacetRow} takes the dimension list, the labels, the
 * facets and the toggle, and each page supplies its own.
 */
import { Check, Filter, X } from "lucide-react";
import type { MetricFacetValue } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { MenuItem, Popover } from "../ui/Popover.js";
import { Select } from "../ui/Select.js";
import { RANGE_PRESETS } from "../../stores/metrics.js";
import type { DimLabeller } from "./labels.js";
import { cn } from "../../lib/cn.js";

const num = new Intl.NumberFormat();

/**
 * What a NULL column means, per dimension.
 *
 * The facets endpoint reports these as `""` because that is what the column
 * holds; the server spells them out in its own labels, but a facet value is a
 * bare string, so the list has to say it here or offer a blank row.
 *
 * `subagent` and `runId` are the same fact seen two ways — a span with no run
 * id came from the chat's main loop — and both say so, because "(none)" on the
 * BIGGEST group of every window is the page's most misreadable label.
 */
export function emptyLabel(dim: string): string {
  if (dim === "agent") return "(default agent)";
  if (dim === "subagent" || dim === "runId") return "(main loop)";
  if (dim === "model") return "(default model)";
  return "(none)";
}

/** One dimension's pick-list, as a popover of checkable rows. */
function FacetPicker<D extends string>({
  dim,
  title,
  values,
  selected,
  toggle,
  clear,
  label,
}: {
  dim: D;
  title: string;
  values: MetricFacetValue[];
  selected: string[] | undefined;
  toggle: (dim: D, value: string) => void;
  clear: (dim: D) => void;
  label: DimLabeller<D>;
}) {
  const count = selected?.length ?? 0;

  // A dimension with nothing (or only one thing) to choose between is not a
  // choice — rendering it as a control that can't change the answer is noise.
  if (values.length < 2) return null;

  return (
    <Popover
      align="start"
      width={260}
      className="max-h-[320px] overflow-y-auto p-1"
      trigger={({ open, toggle: openMenu }) => (
        // `aria-pressed` drives the pressed LOOK as well as the accessible
        // state (see Button's `toggle` variant), so a chip that reads as
        // filtered and a chip that IS filtered cannot drift apart.
        <Button
          variant="toggle"
          onClick={openMenu}
          aria-pressed={count > 0}
          className={cn(open && "text-secondary")}
        >
          {title}
          {count > 0 && <span className="cm-mono !text-2xs">{count}</span>}
        </Button>
      )}
    >
      {(close) => (
        <>
          {count > 0 && (
            <MenuItem
              icon={<X />}
              onClick={() => {
                clear(dim);
                close();
              }}
            >
              Clear {title.toLowerCase()}
            </MenuItem>
          )}
          {values.map((v) => {
            const on = selected?.includes(v.value) ?? false;
            return (
              <MenuItem
                key={v.value || "(none)"}
                // Selection is a bold check; hover is the row's ghost wash, so
                // hover never competes with what is actually selected. The
                // unselected rows still reserve the check's width, or the labels
                // would shift sideways as you pick.
                icon={
                  <Check
                    className={on ? "text-accent" : "text-transparent"}
                    strokeWidth={2.5}
                  />
                }
                active={on}
                hint={num.format(v.count)}
                onClick={() => toggle(dim, v.value)}
              >
                {v.value === "" ? emptyLabel(dim) : label(dim, v.value)}
              </MenuItem>
            );
          })}
        </>
      )}
    </Popover>
  );
}

/**
 * The whole row: range preset, then one pick-list per filterable dimension.
 *
 * `filter` is `Partial<Record<D, string[]>>` rather than the ledger's own filter
 * type so the same component serves both halves; each store's filter satisfies
 * it structurally.
 */
export function FacetRow<D extends string>({
  rangeId,
  setRange,
  dims,
  dimLabels,
  facets,
  filter,
  toggle,
  clear,
  label,
}: {
  rangeId: string;
  setRange: (id: string) => void;
  dims: readonly D[];
  dimLabels: Record<D, string>;
  facets: Partial<Record<D, MetricFacetValue[]>> | undefined;
  filter: Partial<Record<D, string[]>>;
  toggle: (dim: D, value: string) => void;
  clear: (dim?: D) => void;
  label: DimLabeller<D>;
}) {
  const active = Object.values(filter).reduce<number>(
    (n, values) => n + ((values as string[] | undefined)?.length ?? 0),
    0,
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        options={RANGE_PRESETS.map((r) => ({ value: r.id, label: r.label }))}
        value={rangeId}
        onChange={setRange}
        label="Range"
        width={200}
      />
      <span className="mx-0.5 h-4 w-px bg-line-soft" aria-hidden />
      <Filter className="size-3.5 shrink-0 text-faint" aria-hidden />
      {dims.map((dim) => (
        <FacetPicker
          key={dim}
          dim={dim}
          title={dimLabels[dim]}
          values={facets?.[dim] ?? []}
          selected={filter[dim]}
          toggle={toggle}
          clear={clear}
          label={label}
        />
      ))}
      {active > 0 && (
        <Button variant="link" leftIcon={<X />} onClick={() => clear()}>
          Clear all
        </Button>
      )}
    </div>
  );
}
