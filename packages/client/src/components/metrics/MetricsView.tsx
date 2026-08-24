/**
 * The Metrics screen — the shell over its two subpages.
 *
 * The ledger has two halves and they answer different questions. USAGE counts
 * what agents reached for (400 Bash calls); RUNTIME measures where the wall
 * clock went (those calls cost nine hours, six of them waiting on a shell). One
 * page holding both would have to carry two hero figures, two filter rows and
 * two chart control strips stacked on top of each other, and the reader would
 * have to work out which control scoped which half.
 *
 * SUBPAGES rather than one long page, and a tab strip rather than a second
 * entry in the app's nav: the two halves share a subject and a shape, so
 * "Metrics" stays one destination and the tab picks the measure. It follows the
 * app-settings pattern — the selected subpage is navigation state in
 * `stores/view`, not a `useState` here, so it survives leaving the page and is
 * addressable from outside.
 *
 * WHAT IS ACTUALLY DUPLICATED, because "a subpage means two of everything" was
 * the reasonable objection: nothing structural. The header, the range presets,
 * the facet pickers, the chart, the legend, the hero/tile/card furniture and
 * the labellers are all shared (`MetricsFilters`, `MetricsChart`, `chrome`,
 * `labels`). What each subpage owns is its dimension LIST and its measure's
 * formatter — and those cannot be shared, because the dimensions are disjoint:
 * `state` and `class` do not exist in the event table, `category` does not exist
 * in the span table, and sending either to the other's endpoint is a 400 rather
 * than a narrower answer. Even folded into the existing page as a section, the
 * runtime half would have needed its own filter row for exactly that reason —
 * which is a second filter row on a page that already has one, and the thing
 * this layout avoids.
 */
import { Activity, BarChart3, Gauge, RefreshCw } from "lucide-react";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { Tabs } from "../ui/Tabs.js";
import { useMetrics } from "../../stores/metrics.js";
import { useSpanMetrics } from "../../stores/metrics-spans.js";
import { useResources } from "../../stores/resources.js";
import { useView, type MetricsSection } from "../../stores/view.js";
import { RuntimeMetrics } from "./RuntimeMetrics.js";
import { UsageMetrics } from "./UsageMetrics.js";
import { ResourceMetrics } from "./ResourceMetrics.js";
import { count } from "./chrome.js";
import { cn } from "../../lib/cn.js";

export function MetricsView() {
  const section = useView((s) => s.metricsSection);
  const setSection = useView((s) => s.setMetricsSection);

  // The header's row count and reload button belong to whichever half is
  // showing. One shared "rows" figure would be the sum of two tables that
  // measure different things, which is a number with no meaning.
  const usageRows = useMetrics((s) => s.ledgerRows);
  const usageBusy = useMetrics((s) => s.refetching);
  const reloadUsage = useMetrics((s) => s.load);
  const spanRows = useSpanMetrics((s) => s.ledgerRows);
  const spanBusy = useSpanMetrics((s) => s.refetching);
  const reloadSpans = useSpanMetrics((s) => s.load);

  // Resources is a LIVE READING rather than a ledger, so its "rows" is the
  // number of chats currently holding something and its reload is a re-scan,
  // not a re-query. Same three controls, different meaning per subpage.
  const resourceChats = useResources((s) => s.snapshot?.chats.length ?? 0);
  const resourceBusy = useResources((s) => s.refetching);
  const rescan = useResources((s) => s.refreshSnapshot);

  const runtime = section === "runtime";
  const resources = section === "resources";
  const rows = resources ? resourceChats : runtime ? spanRows : usageRows;
  const busy = resources ? resourceBusy : runtime ? spanBusy : usageBusy;
  // FORCED for the resource tab. Its snapshot is served off a 10 s table
  // cache, so a plain refetch inside that window returns a byte-identical
  // answer and the button reads as broken.
  const reload = resources ? () => rescan(true) : runtime ? reloadSpans : reloadUsage;
  const unit = resources ? "chats" : runtime ? "spans" : "rows";

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 cm-hairline-b">
        <BarChart3 className="size-4 text-muted" />
        <span className="text-base font-semibold text-primary">Metrics</span>
        <Tabs
          value={section}
          onChange={(id) => setSection(id as MetricsSection)}
          tabs={[
            { id: "usage", label: "Usage", icon: <BarChart3 size={13} /> },
            { id: "runtime", label: "Runtime", icon: <Activity size={13} /> },
            { id: "resources", label: "Resources", icon: <Gauge size={13} /> },
          ]}
        />
        <span className="cm-mono !text-2xs text-faint">
          {count(rows)} {unit}
        </span>
        <div className="flex-1" />
        <IconButton size="sm" tip="Reload" onClick={() => void reload()}>
          <RefreshCw className={cn(busy && "animate-spin")} />
        </IconButton>
      </div>

      {/* Only the active subpage is mounted, so a tab flip re-runs that half's
          mount load. That is deliberate rather than wasteful: the window is
          relative to `Date.now()`, so a "last 7 days" render held from an hour
          ago is quietly answering a different question than its own label. */}
      <ScrollArea className="min-h-0 flex-1">
        {resources ? <ResourceMetrics /> : runtime ? <RuntimeMetrics /> : <UsageMetrics />}
      </ScrollArea>
    </div>
  );
}
