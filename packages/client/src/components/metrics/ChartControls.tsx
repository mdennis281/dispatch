import type { ReactNode } from "react";
import type { MetricBucket } from "@dispatch/shared";
import { Select } from "../ui/Select.js";
import { CHART_KIND_LABELS, type ChartKind } from "../../stores/metrics.js";

const BUCKET_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const LIMIT_OPTIONS = [4, 6, 8].map((n) => ({ value: String(n), label: `Top ${n}` }));

/**
 * The Chart / Split by / Bucket / Series row above the configurable chart on
 * the Usage, Runtime and Tokens tabs. Each tab carried its own ~45-line copy,
 * identical but for the dimension list. A new bucket size or series count used
 * to need three edits, and missing one left that tab quietly behind.
 *
 * `extra` goes between Chart and Split by. It holds the Tokens tab's Measure
 * picker, which the other two tabs have no use for.
 */
export function ChartControls<D extends string>({
  kinds,
  chart,
  setChart,
  extra,
  dims,
  dimLabels,
  groupBy,
  setGroupBy,
  splitWidth = 180,
  timeForm,
  bucket,
  setBucket,
  limit,
  setLimit,
}: {
  /** Chart forms offered, in this tab's order. */
  kinds: readonly ChartKind[];
  chart: ChartKind;
  setChart: (kind: ChartKind) => void;
  extra?: ReactNode;
  dims: readonly D[];
  dimLabels: Record<D, string>;
  groupBy: D;
  setGroupBy: (dim: D) => void;
  splitWidth?: number;
  /** A time form (not the donut/ranked share forms) — the only ones with a bucket to pick. */
  timeForm: boolean;
  bucket: MetricBucket;
  setBucket: (bucket: MetricBucket) => void;
  limit: number;
  setLimit: (limit: number) => void;
}) {
  return (
    <>
      <Select
        options={kinds.map((k) => ({ value: k, label: CHART_KIND_LABELS[k] }))}
        value={chart}
        onChange={(v) => setChart(v as ChartKind)}
        label="Chart"
        width={180}
      />
      {extra}
      <Select
        options={dims.map((d) => ({ value: d, label: dimLabels[d] }))}
        value={groupBy}
        onChange={(v) => setGroupBy(v as D)}
        label="Split by"
        width={splitWidth}
      />
      {/* Bucket only exists for the time forms; a donut has no time axis to
          bucket, so the control would be inert. */}
      {timeForm && (
        <Select
          options={BUCKET_OPTIONS}
          value={bucket}
          onChange={(v) => setBucket(v as MetricBucket)}
          label="Bucket"
          width={150}
        />
      )}
      <Select
        options={LIMIT_OPTIONS}
        value={String(limit)}
        onChange={(v) => setLimit(Number(v))}
        label="Series"
        width={140}
      />
    </>
  );
}
