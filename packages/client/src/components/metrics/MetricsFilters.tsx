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
 */
import { Check, Filter, X } from "lucide-react";
import type { MetricDimension, MetricFacetValue } from "@dispatch/shared";
import { METRIC_DIMENSION_LABELS } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { MenuItem, Popover } from "../ui/Popover.js";
import { Select } from "../ui/Select.js";
import { activeFilterCount, RANGE_PRESETS, useMetrics } from "../../stores/metrics.js";
import { useMetricLabel } from "./labels.js";
import { cn } from "../../lib/cn.js";

/** Dimensions offered as pick-lists, in the order they read. */
const FILTERABLE: MetricDimension[] = [
  "projectId",
  "agent",
  "subagent",
  "category",
  "model",
  "harness",
  "source",
];

const num = new Intl.NumberFormat();

/**
 * What a NULL column means, per dimension.
 *
 * The facets endpoint reports these as `""` because that is what the column
 * holds; the server spells them out in its own labels, but a facet value is a
 * bare string, so the list has to say it here or offer a blank row.
 */
function emptyLabel(dim: MetricDimension): string {
  if (dim === "agent") return "(default agent)";
  if (dim === "subagent") return "(main loop)";
  if (dim === "model") return "(default model)";
  return "(none)";
}

/** One dimension's pick-list, as a popover of checkable rows. */
function FacetPicker({
  dim,
  values,
}: {
  dim: MetricDimension;
  values: MetricFacetValue[];
}) {
  const selected = useMetrics((s) => s.filter[dim]);
  const toggle = useMetrics((s) => s.toggleFilter);
  const clear = useMetrics((s) => s.clearFilter);
  const label = useMetricLabel(dim);
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
          {METRIC_DIMENSION_LABELS[dim]}
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
              Clear {METRIC_DIMENSION_LABELS[dim].toLowerCase()}
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
                {v.value === "" ? emptyLabel(dim) : label(v.value)}
              </MenuItem>
            );
          })}
        </>
      )}
    </Popover>
  );
}

export function MetricsFilters() {
  const rangeId = useMetrics((s) => s.rangeId);
  const setRange = useMetrics((s) => s.setRange);
  const facets = useMetrics((s) => s.facets);
  const filter = useMetrics((s) => s.filter);
  const clear = useMetrics((s) => s.clearFilter);
  const active = activeFilterCount(filter);

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
      {FILTERABLE.map((dim) => (
        <FacetPicker key={dim} dim={dim} values={facets?.facets[dim] ?? []} />
      ))}
      {active > 0 && (
        <Button variant="link" leftIcon={<X />} onClick={() => clear()}>
          Clear all
        </Button>
      )}
    </div>
  );
}
