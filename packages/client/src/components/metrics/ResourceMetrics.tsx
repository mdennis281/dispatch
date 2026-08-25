/**
 * The Resources subpage — which chat is eating the machine, and what inside it.
 *
 * A THIRD METRICS SUBPAGE rather than its own destination, because it answers
 * the same shape of question as the other two: Usage counts what agents reached
 * for, Runtime measures where the wall clock went, Resources measures what is
 * resident right now. Same header, same tab strip, one destination.
 *
 * ── THE MEMORY NUMBERS NEED A HEALTH WARNING, SO THEY GET ONE ────────────────
 *
 * Resident set counts SHARED pages once per process, so summing it over a tree
 * of a dozen `node` processes overstates by ~1.9x (measured: 16.4 GB reported
 * against 8.7 GB real). The accurate figure costs seven seconds to collect and
 * is therefore not collected.
 *
 * The page defaults to RELATIVE — share-of-total bars — because the ranking is
 * sound even though the absolute is not, and ranking is the actual question
 * ("which chat do I reap"). Absolutes are behind a toggle, and when shown they
 * are marked `≈` and corrected by {@link SHARED_PAGE_FACTOR} rather than
 * printed raw, because a raw total that exceeds installed RAM reads as a bug.
 *
 * ── CPU IS BLANK BEFORE IT IS ZERO ───────────────────────────────────────────
 *
 * A rate needs two samples, so the first poll after opening this page has no
 * CPU figures at all and shows "—". `windowMs` in the footer says what interval
 * the percentages actually cover, because the sampler is demand-driven and the
 * window is however long since the last poll rather than a fixed cadence.
 */
import { useEffect, useState } from "react";
import { ChevronRight, Cpu, Server, Skull } from "lucide-react";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { SHARED_PAGE_FACTOR, type ChatResources } from "@dispatch/shared";
import { useResources, share, machinePct } from "../../stores/resources.js";
import { useChats } from "../../stores/chats.js";
import { useChatProcesses } from "../../stores/chatProcesses.js";
import { bytes, pct, dur } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/** Bar tone by share of the machine. */
function tone(p: number): string {
  if (p >= 40) return "bg-danger";
  if (p >= 15) return "bg-warn";
  return "bg-accent";
}

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
export function nextAutoSort(
  current: SortKey,
  chats: readonly ChatResources[],
): SortKey {
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

/** A labelled figure with a bar under it — the hero tiles across the top. */
function Tile({
  label,
  value,
  sub,
  pctOf,
  barClass,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  pctOf?: number;
  barClass?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-md border border-line bg-panel-2/40 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        {icon}
        <span className="truncate text-2xs uppercase tracking-wide text-faint">{label}</span>
      </div>
      <div className="cm-mono text-lg font-semibold leading-tight text-primary">{value}</div>
      {pctOf !== undefined && (
        <div className="relative mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              // Animated because these bars are re-rendered every poll with a
              // new number: a bar that JUMPS reads as a fresh render, one that
              // slides reads as the same quantity moving, which is what makes
              // a 5 s poll feel like a live reading rather than a slideshow.
              "transition-[width] duration-500 ease-[var(--ease-out)]",
              barClass ?? "bg-accent",
            )}
            style={{ width: `${pctOf}%` }}
          />
        </div>
      )}
      {sub && <div className="mt-1 truncate text-2xs text-faint">{sub}</div>}
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
  absolute,
  cores,
  sort,
}: {
  chat: ChatResources;
  /** Bytes that count as "100%" for the bar — the machine's total. */
  denominator: number;
  absolute: boolean;
  cores: number;
  /** Which column the table is ranked by — the bar tracks it. */
  sort: SortKey;
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
  // The bar shows whatever the table is RANKED by. A memory bar under a table
  // sorted by CPU is the bug this page shipped with: the row that was pinning
  // ten cores drew a stub of a bar because its memory was unremarkable, so the
  // one visual cue on the row pointed away from the answer.
  const barShare = sort === "cpu" ? share(chat.cpuPct ?? 0, 100 * cores) : memShare;

  return (
    <div className="cm-hairline-b">
      <div className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-active/40">
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
          </div>
          <div className="mt-1 relative h-1 w-full overflow-hidden rounded-full bg-line">
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                "transition-[width] duration-500 ease-[var(--ease-out)]",
                tone(barShare),
              )}
              style={{ width: `${barShare}%` }}
            />
          </div>
        </div>

        <div className="w-20 shrink-0 text-right">
          <div className="cm-mono text-xs font-semibold text-primary">
            {absolute ? `≈${bytes(corrected)}` : `${memShare.toFixed(1)}%`}
          </div>
          <div className="text-2xs text-faint">
            {chat.session.procs}+{chat.shells.procs} proc
          </div>
        </div>

        <div className="w-16 shrink-0 text-right">
          {/* Machine-relative, so this column is comparable with the machine
              and Dispatch tiles above and the rows add up. The secondary line
              gives the same figure in cores, which is the form that actually
              means something for one busy chat ("it is using 2.4 cores"). */}
          <div className="cm-mono text-xs text-secondary">
            {pct(machinePct(chat.cpuPct, cores))}
          </div>
          {chat.cpuPct !== null && (
            <div className="text-2xs text-faint">{(chat.cpuPct / 100).toFixed(1)}× core</div>
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
                <span className="cm-mono w-16 shrink-0 text-right text-2xs text-primary">
                  {bytes(p.rssBytes)}
                </span>
                <span className="cm-mono w-12 shrink-0 text-right text-2xs text-muted">
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

export function ResourceMetrics() {
  const snapshot = useResources((s) => s.snapshot);
  const loading = useResources((s) => s.loading);
  const subscribe = useResources((s) => s.subscribeSnapshot);
  const [absolute, setAbsolute] = useState(false);
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
  const dispatchCorrected = (dispatch?.rssBytes ?? 0) / SHARED_PAGE_FACTOR;
  const cores = system.logicalCores;

  // An explicit click WINS and keeps winning; otherwise follow the damped
  // automatic choice above.
  const sort = picked ?? auto;
  const rows = sortChats(chats, sort);

  // No ScrollArea here: `MetricsView` already wraps every subpage in one, and
  // nesting two makes the inner one swallow the wheel events the outer needs.
  return (
    <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap gap-2">
          <Tile
            label="Machine memory"
            value={`${bytes(system.usedBytes)} / ${bytes(system.totalBytes)}`}
            pctOf={share(system.usedBytes, system.totalBytes)}
            barClass={tone(share(system.usedBytes, system.totalBytes))}
            sub={`${bytes(system.freeBytes)} free`}
            icon={<Server className="size-3 text-faint" />}
          />
          <Tile
            label="Machine CPU"
            value={pct(system.cpuPct)}
            pctOf={system.cpuPct ?? 0}
            sub={`${cores} logical cores`}
            icon={<Cpu className="size-3 text-faint" />}
          />
          <Tile
            label="Dispatch memory"
            value={dispatch ? `≈${bytes(dispatchCorrected)}` : "—"}
            pctOf={share(dispatchCorrected, system.totalBytes)}
            barClass={tone(share(dispatchCorrected, system.totalBytes))}
            sub={
              dispatch
                ? `${Math.round(share(dispatchCorrected, system.totalBytes))}% of machine · ${dispatch.procs} procs`
                : undefined
            }
          />
          <Tile
            label="Dispatch CPU"
            value={pct(machinePct(dispatch?.cpuPct ?? null, cores))}
            pctOf={share(dispatch?.cpuPct ?? 0, 100 * cores)}
            sub={
              dispatch
                ? `server ${bytes(dispatch.serverRssBytes)} · ${chats.length} chats`
                : undefined
            }
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
            ) in Dispatch's tree belong to no chat — the server itself, sub-app runners, and
            anything orphaned mid-teardown. The DB is inside the server process, not separate.
          </div>
        )}

        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-panel-2/50 px-3 py-1.5">
            <span className="text-xs font-semibold text-primary">By chat</span>
            <span className="cm-mono text-2xs text-faint">{chats.length}</span>
            <div className="flex-1" />
            <Button variant="link" size="sm" onClick={() => setAbsolute((v) => !v)}>
              {absolute ? "show relative" : "show absolute"}
            </Button>
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
              <ChatRow
                key={c.chatId}
                chat={c}
                denominator={system.totalBytes}
                absolute={absolute}
                cores={cores}
                sort={sort}
              />
            ))
          )}
        </div>

        <div className="px-1 text-2xs leading-relaxed text-faint">
          {snapshot.windowMs > 0 ? (
            <>CPU averaged over the last {dur(snapshot.windowMs) ?? "—"}. </>
          ) : (
            <>CPU needs a second sample — figures appear on the next poll. </>
          )}
          Memory is resident set, which counts pages shared between processes once per
          process; absolutes are divided by {SHARED_PAGE_FACTOR}× to approximate real usage
          and are marked ≈. Ranking between chats is reliable; the totals are estimates.
        </div>
    </div>
  );
}
