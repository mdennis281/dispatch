/**
 * The Resources subpage — which chat is eating the machine, and what inside it.
 *
 * A THIRD METRICS SUBPAGE rather than its own destination, because it answers
 * the same shape of question as the other two: Usage counts what agents reached
 * for, Runtime measures where the wall clock went, Resources measures what is
 * resident right now. Same header, same tab strip, one destination.
 *
 * ── TWO CARDS, NOT FOUR TILES ────────────────────────────────────────────────
 *
 * The page shipped with a tile each for machine memory, machine CPU, Dispatch
 * memory and Dispatch CPU — four bars, each against its own full-width track,
 * and the one question a reader actually brings ("how much of that is us")
 * answered only by dividing tile three by tile one in their head. The same four
 * numbers nest into two: one bar per metric, Dispatch's slice drawn bright
 * inside the dim total. Half the width, the comparison for free. See
 * `SplitBar`, and `memorySplit`/`cpuSplit` for the arithmetic.
 *
 * ── EVERY ROW DRAWS BOTH METRICS ─────────────────────────────────────────────
 *
 * A chat row used to draw ONE bar and switch which metric it meant depending on
 * how the table was sorted — a patch for the original defect, where a memory
 * bar sat under a table ranked by CPU and pointed away from the answer. Two
 * bars, always, is the fix that patch was approximating: memory above, CPU
 * below, told apart by hue (see `lib/resourceTone`). The bar no longer depends
 * on the sort, so it cannot disagree with it.
 *
 * ── THE MEMORY NUMBERS NEED A HEALTH WARNING, SO THEY GET ONE ────────────────
 *
 * Resident set counts SHARED pages once per process, so summing it over a tree
 * of a dozen `node` processes overstates by ~1.9x (measured: 16.4 GB reported
 * against 8.7 GB real). The accurate figure costs seven seconds to collect and
 * is therefore not collected.
 *
 * So every row leads with the RELATIVE figure — a share of the machine, whose
 * ranking is sound — and carries the absolute underneath it in faint, marked
 * `≈` and corrected by {@link SHARED_PAGE_FACTOR}. That pairing replaced a
 * relative/absolute TOGGLE: with the row showing both at once there was nothing
 * left for it to switch, and a control that answers a question already on
 * screen is a control worth deleting.
 *
 * ── CPU IS BLANK BEFORE IT IS ZERO ───────────────────────────────────────────
 *
 * A rate needs two samples, so the first poll after opening this page has no
 * CPU figures at all and shows "—". `windowMs` in the footer says what interval
 * the percentages actually cover, because the sampler is demand-driven and the
 * window is however long since the last poll rather than a fixed cadence.
 */
import { useEffect, useState } from "react";
import { ChevronRight, Cpu, MemoryStick, Skull } from "lucide-react";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { SplitBar, SplitDot } from "../ui/SplitBar.js";
import { SHARED_PAGE_FACTOR, type ChatResources } from "@dispatch/shared";
import {
  useResources,
  share,
  machinePct,
  memorySplit,
  cpuSplit,
  type ResourceSplit,
} from "../../stores/resources.js";
import { useChats } from "../../stores/chats.js";
import { useChatProcesses } from "../../stores/chatProcesses.js";
import { bytes, pct, dur } from "../../lib/format.js";
import { CPU_BAR, chatCpuTone, chatTone, machineTone } from "../../lib/resourceTone.js";
import { cn } from "../../lib/cn.js";

/** Which column the table is ranked by. */
export type SortKey = "mem" | "cpu" | "procs";

/**
 * A chat is using enough CPU that CPU is the interesting column.
 *
 * ONE FULL CORE, expressed the way the server reports it (a share of one core).
 * Below that a chat is doing ordinary work; above it, something is running hot
 * and that is what the reader came to find. Deliberately not "the machine is
 * busy" — a pegged machine with the load spread evenly over nine chats is a
 * memory story, and this only fires when a single row is the answer.
 */
const CPU_INTERESTING_PCT = 100;

/**
 * ...and the level it has to fall back to before CPU stops being interesting.
 *
 * HALF A CORE, not the same number, because a single threshold FLAPS. Caught
 * live: one chat sitting right on 1.0 core had the automatic choice recomputed
 * every 5 s poll, so the table re-sorted itself between memory and CPU on
 * alternate refreshes. With one row that is invisible; with nine it is a table
 * that reshuffles under the reader twice a poll.
 */
const CPU_BORING_PCT = 50;

/**
 * Which column to rank by when the reader hasn't clicked one.
 *
 * The page shipped sorting by memory ALWAYS, and that was the defect: a chat
 * pinning ten cores sat wherever its memory happened to put it, so the one
 * ordering cue on the page pointed away from the answer. Now the default
 * follows the pressure — with hysteresis, so following it does not mean
 * twitching.
 *
 * @param current What the automatic choice settled on last poll.
 */
export function nextAutoSort(current: SortKey, chats: readonly ChatResources[]): SortKey {
  const hottest = chats.reduce((max, c) => Math.max(max, c.cpuPct ?? 0), 0);
  if (hottest >= CPU_INTERESTING_PCT) return "cpu";
  // Only leave CPU once things have gone properly quiet, and never touch a
  // "procs" choice — that one can only come from a click, and a click wins.
  if (current === "cpu" && hottest < CPU_BORING_PCT) return "mem";
  return current;
}

/** Rank chats by one column, biggest first, with a stable tiebreak. */
export function sortChats(chats: readonly ChatResources[], by: SortKey): ChatResources[] {
  const key = (c: ChatResources): number =>
    by === "cpu" ? (c.cpuPct ?? -1) : by === "procs" ? c.procs : c.rssBytes;
  // `chatId` as the final tiebreak, not insertion order: rows that compare
  // equal must not swap places between polls, which on a 5 s refresh reads as
  // the table shuffling itself.
  return [...chats].sort((a, b) => key(b) - key(a) || a.chatId.localeCompare(b.chatId));
}

/** One line of a hero card's legend: swatch, what it is, how much, in what. */
function LegendRow({
  layer,
  barTone,
  label,
  value,
  sub,
}: {
  layer: "share" | "other" | "free";
  barTone: string;
  label: string;
  value: string;
  /** The same quantity in its other useful unit — a percent, or cores. */
  sub: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <SplitDot layer={layer} tone={barTone} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-2xs",
          layer === "share" ? "text-secondary" : "text-faint",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "cm-mono shrink-0 text-2xs tabular-nums",
          layer === "share" ? "text-primary" : "text-muted",
        )}
      >
        {value}
      </span>
      <span className="cm-mono w-16 shrink-0 text-right text-2xs tabular-nums text-faint">
        {sub}
      </span>
    </div>
  );
}

/** One metric across the top of the page: headline, split bar, three legends. */
function HeroCard({
  icon,
  label,
  headline,
  denom,
  split,
  barTone,
  legend,
}: {
  icon: React.ReactNode;
  label: string;
  headline: string;
  /** The quieter half of the headline — "/ 64 GB", "of 16 cores". */
  denom: string;
  split: ResourceSplit;
  barTone: string;
  legend: { label: string; value: string; sub: string }[];
}) {
  return (
    <div className="min-w-0 flex-1 basis-64 rounded-md border border-line bg-panel-2/40 px-3 py-2.5">
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="self-center">{icon}</span>
        <span className="text-2xs uppercase tracking-wide text-faint">{label}</span>
        <div className="flex-1" />
        <span className="cm-mono text-lg font-semibold leading-none tabular-nums text-primary">
          {headline}
        </span>
        <span className="cm-mono text-2xs tabular-nums text-faint">{denom}</span>
      </div>
      <SplitBar
        size="lg"
        usedPct={split.usedPct}
        sharePct={split.dispatch === null ? null : split.dispatchPct}
        tone={barTone}
      />
      <div className="mt-2 space-y-1">
        {(["share", "other", "free"] as const).map((layer, i) => (
          <LegendRow
            key={layer}
            layer={layer}
            barTone={barTone}
            label={legend[i]!.label}
            value={legend[i]!.value}
            sub={legend[i]!.sub}
          />
        ))}
      </div>
    </div>
  );
}

/** One column header in the sort strip. `Button toggle` carries the on-state. */
function SortTab({
  id,
  sort,
  onPick,
  children,
}: {
  id: SortKey;
  sort: SortKey;
  onPick: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="toggle"
      size="sm"
      aria-pressed={sort === id}
      onClick={() => onPick(id)}
      className={cn("!px-1.5 !text-2xs", sort === id && "text-primary")}
    >
      {children}
    </Button>
  );
}

/** One chat's row, expandable into its individual processes. */
function ChatRow({
  chat,
  denominator,
  cores,
}: {
  chat: ChatResources;
  /** Bytes that count as "100%" for the memory bar — the machine's total. */
  denominator: number;
  cores: number;
}) {
  const [open, setOpen] = useState(false);
  const detail = useResources((s) => s.details[chat.chatId]);
  const loadDetail = useResources((s) => s.loadDetail);
  const title = useChats((s) => s.byId[chat.chatId]?.title);
  const kill = useChatProcesses((s) => s.kill);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    if (open) void loadDetail(chat.chatId);
  }, [open, chat.chatId, loadDetail]);

  const corrected = chat.rssBytes / SHARED_PAGE_FACTOR;
  const memShare = share(corrected, denominator);
  // Machine-relative, so this is on the same scale as the memory bar above it
  // and as the cards at the top of the page, and the rows add up. The raw
  // server figure is a share of ONE core. See `machinePct`.
  const cpuShare = share(chat.cpuPct ?? 0, 100 * cores);

  return (
    <div className="cm-hairline-b">
      <div className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-active/40">
        <IconButton
          onClick={() => setOpen((v) => !v)}
          tip={open ? "Collapse" : "Expand"}
          className="shrink-0"
        >
          <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
        </IconButton>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-primary">
              {title ?? <span className="text-faint">{chat.chatId.slice(0, 8)}</span>}
            </span>
            {/* WHAT is costing this, not just how much. A percentage tells you
                a chat is expensive; "chrome.exe ×17" tells you what to do about
                it — and that was the fact buried behind an expand when a
                leftover headless browser was pinning ten cores. */}
            {chat.hottest && chat.hottest.count > 0 && (
              <span className="cm-mono shrink-0 text-2xs text-faint">
                {chat.hottest.name}
                {chat.hottest.count > 1 && `×${chat.hottest.count}`}
              </span>
            )}
            <div className="flex-1" />
            {/* Session and shells kept apart because an idle sweep reclaims the
                first and never the second. */}
            <span className="cm-mono shrink-0 text-2xs tabular-nums text-faint">
              {chat.session.procs}+{chat.shells.procs}
            </span>
          </div>
          {/* Memory above, CPU below, in that order everywhere on this page —
              including the two columns to the right, which are in the same
              order left to right. */}
          <div className="mt-1 flex flex-col gap-0.5">
            <SplitBar
              size="sm"
              usedPct={memShare}
              tone={chatTone(memShare)}
              title={`memory ${memShare.toFixed(1)}% of machine`}
            />
            <SplitBar
              size="sm"
              usedPct={cpuShare}
              tone={chatCpuTone(cpuShare)}
              title={
                chat.cpuPct === null
                  ? "CPU not measured yet"
                  : `CPU ${cpuShare.toFixed(1)}% of machine`
              }
            />
          </div>
        </div>

        <div className="w-16 shrink-0 text-right">
          <div className="cm-mono text-xs font-semibold tabular-nums text-primary">
            {memShare.toFixed(1)}%
          </div>
          <div className="cm-mono text-2xs tabular-nums text-faint">≈{bytes(corrected)}</div>
        </div>

        <div className="w-16 shrink-0 text-right">
          <div className="cm-mono text-xs tabular-nums text-secondary">
            {pct(machinePct(chat.cpuPct, cores))}
          </div>
          {/* The same figure in cores, which is the form that actually means
              something for one busy chat ("it is using 2.4 cores"). */}
          {chat.cpuPct !== null && (
            <div className="cm-mono text-2xs tabular-nums text-faint">
              {(chat.cpuPct / 100).toFixed(1)}× core
            </div>
          )}
        </div>

        <IconButton
          disabled={killing}
          onClick={async () => {
            setKilling(true);
            // Reaps this chat only. The sidebar's button reaps a whole BRANCH
            // (a chat plus its reviewers) because that is what its number
            // counts; here each chat is its own row, so folding children in
            // would kill things the row never claimed.
            await kill([chat.chatId]).catch(() => 0);
            setKilling(false);
          }}
          tip="Stop this chat's session and shells"
          // Destructive hover on an icon-only control: `IconButton` has no
          // danger variant, and `Button danger` would carry its ghost
          // background at rest on every row in the table.
          className="shrink-0 hover:!bg-danger/15 hover:!text-danger"
        >
          <Skull />
        </IconButton>
      </div>

      {open && (
        <div className="border-t border-line-soft bg-panel-2/30 px-3 py-1.5 pl-9">
          {!detail ? (
            <div className="py-1 text-2xs text-faint">measuring…</div>
          ) : detail.procs.length === 0 ? (
            <div className="py-1 text-2xs text-faint">nothing resident</div>
          ) : (
            detail.procs.map((p) => (
              <div key={p.pid} className="flex items-center gap-2 py-0.5">
                <span
                  className={cn(
                    "w-11 shrink-0 text-2xs",
                    p.kind === "shell" ? "text-warn" : "text-faint",
                  )}
                >
                  {p.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-secondary">
                  {p.name ?? "?"}
                  <span className="text-faint"> · {p.pid}</span>
                </span>
                <span className="cm-mono w-16 shrink-0 text-right text-2xs tabular-nums text-primary">
                  {bytes(p.rssBytes)}
                </span>
                <span className="cm-mono w-12 shrink-0 text-right text-2xs tabular-nums text-muted">
                  {pct(machinePct(p.cpuPct, cores))}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Which hue means which metric, said once for the whole table below it. */
function BarKey({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-faint">
      <span className={cn("h-[3px] w-3 rounded-full", tone)} />
      {label}
    </span>
  );
}

export function ResourceMetrics() {
  const snapshot = useResources((s) => s.snapshot);
  const loading = useResources((s) => s.loading);
  const subscribe = useResources((s) => s.subscribeSnapshot);
  /** `null` = nobody has clicked a column, so follow the pressure. */
  const [picked, setPicked] = useState<SortKey | null>(null);
  /** The automatic choice, CARRIED between polls so it can have hysteresis. */
  const [auto, setAuto] = useState<SortKey>("mem");

  // The expensive poll runs exactly while this page is mounted. Reference
  // counted in the store, so the header dropdown wanting the same data at the
  // same time still costs one scan.
  useEffect(() => subscribe(), [subscribe]);

  // Re-evaluated per snapshot, but as a TRANSITION from the last answer rather
  // than from scratch — that is what `nextAutoSort`'s two thresholds need to
  // damp. Skipped entirely once the reader has picked a column.
  const chatsForAuto = snapshot?.chats;
  useEffect(() => {
    if (picked !== null || !chatsForAuto) return;
    setAuto((cur) => nextAutoSort(cur, chatsForAuto));
  }, [chatsForAuto, picked]);

  if (!snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-faint">
        {loading ? "Scanning the process table…" : "No reading yet."}
      </div>
    );
  }

  const { system, dispatch, chats } = snapshot;
  const cores = system.logicalCores;
  const mem = memorySplit(system, dispatch);
  const cpu = cpuSplit(system, dispatch);
  const memTone = machineTone(mem.usedPct);
  /** A machine-relative CPU percent as a count of cores — "2.9 cores". */
  const inCores = (p: number): string => `${((p * cores) / 100).toFixed(1)} cores`;

  // An explicit click WINS and keeps winning; otherwise follow the damped
  // automatic choice above.
  const sort = picked ?? auto;
  const rows = sortChats(chats, sort);

  // No ScrollArea here: `MetricsView` already wraps every subpage in one, and
  // nesting two makes the inner one swallow the wheel events the outer needs.
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-2">
        <HeroCard
          icon={<MemoryStick className="size-3 text-faint" />}
          label="Memory"
          headline={bytes(system.usedBytes)}
          denom={`/ ${bytes(system.totalBytes)}`}
          split={mem}
          barTone={memTone.bar}
          legend={[
            {
              label: "Dispatch",
              // Marked because the tree sum counts shared pages once per
              // process — see the module note and SHARED_PAGE_FACTOR.
              value: mem.dispatch === null ? "—" : `≈${bytes(mem.dispatch)}`,
              sub: mem.dispatch === null ? "" : `${mem.dispatchPct.toFixed(1)}%`,
            },
            {
              // A claim we cannot make before the first scan — see the same
              // note in the header dropdown's `Meter`.
              label: mem.dispatch === null ? "In use" : "Everything else",
              value: bytes(mem.other),
              sub: `${(mem.usedPct - mem.dispatchPct).toFixed(1)}%`,
            },
            {
              label: "Free",
              value: bytes(mem.free),
              sub: `${(100 - mem.usedPct).toFixed(1)}%`,
            },
          ]}
        />
        <HeroCard
          icon={<Cpu className="size-3 text-faint" />}
          label="CPU"
          headline={pct(system.cpuPct)}
          denom={`of ${cores} cores`}
          split={cpu}
          barTone={CPU_BAR}
          legend={[
            {
              label: dispatch ? `Dispatch · ${dispatch.procs} procs` : "Dispatch",
              value: pct(cpu.dispatch),
              sub: cpu.dispatch === null ? "" : inCores(cpu.dispatch),
            },
            {
              label: cpu.dispatch === null ? "In use" : "Everything else",
              value: cpu.measured ? pct(cpu.other) : "—",
              sub: cpu.measured ? inCores(cpu.other) : "",
            },
            {
              label: "Idle",
              value: cpu.measured ? pct(cpu.free) : "—",
              sub: cpu.measured ? inCores(cpu.free) : "",
            },
          ]}
        />
      </div>

      {/* What the server itself and its sub-app runners hold, as distinct
          from anything a chat can be blamed for. A number that climbs here is
          the signal that something is leaking outside a chat — which no
          per-chat row would ever show. */}
      {dispatch && dispatch.unattributed.procs > 0 && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-2xs text-muted",
            // Loud only when the leftovers are actually BURNING something.
            // A resident server process and a couple of runners is the
            // normal state and should not look like an alarm.
            (dispatch.unattributed.cpuPct ?? 0) >= CPU_INTERESTING_PCT
              ? "border-warn/40 bg-warn/10"
              : "border-line bg-panel-2/30",
          )}
        >
          <span className="font-medium text-secondary">
            {dispatch.unattributed.procs} processes
          </span>{" "}
          (≈{bytes(dispatch.unattributed.rssBytes / SHARED_PAGE_FACTOR)}
          {dispatch.unattributed.cpuPct !== null && (
            <>
              {", "}
              <span
                className={cn(
                  (dispatch.unattributed.cpuPct ?? 0) >= CPU_INTERESTING_PCT &&
                    "font-medium text-warn",
                )}
              >
                {pct(machinePct(dispatch.unattributed.cpuPct, cores))} CPU
              </span>
            </>
          )}
          ) in Dispatch's tree belong to no chat — the server itself (≈
          {bytes(dispatch.serverRssBytes)}), sub-app runners, and anything orphaned
          mid-teardown. The DB is inside the server process, not separate.
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-panel-2/50 px-3 py-1.5">
          <span className="text-xs font-semibold text-primary">By chat</span>
          <span className="cm-mono text-2xs tabular-nums text-faint">{chats.length}</span>
          <span className="mx-1 h-3 w-px bg-line" />
          <BarKey tone="bg-accent" label="memory" />
          <BarKey tone={CPU_BAR} label="CPU" />
          <div className="flex-1" />
          <span className="text-2xs text-faint">sort</span>
          <SortTab id="mem" sort={sort} onPick={setPicked}>
            memory
          </SortTab>
          <SortTab id="cpu" sort={sort} onPick={setPicked}>
            CPU
          </SortTab>
          <SortTab id="procs" sort={sort} onPick={setPicked}>
            procs
          </SortTab>
        </div>
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-faint">
            No chat is holding any processes.
          </div>
        ) : (
          rows.map((c) => (
            <ChatRow key={c.chatId} chat={c} denominator={system.totalBytes} cores={cores} />
          ))
        )}
      </div>

      <div className="px-1 text-2xs leading-relaxed text-faint">
        {snapshot.windowMs > 0 ? (
          <>CPU averaged over the last {dur(snapshot.windowMs) ?? "—"}. </>
        ) : (
          <>CPU needs a second sample — figures appear on the next poll. </>
        )}
        Memory is resident set, which counts pages shared between processes once per process;
        absolutes are divided by {SHARED_PAGE_FACTOR}× to approximate real usage and are marked
        ≈. Ranking between chats is reliable; the totals are estimates.
      </div>
    </div>
  );
}
