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
            className={cn("absolute inset-y-0 left-0 rounded-full", barClass ?? "bg-accent")}
            style={{ width: `${pctOf}%` }}
          />
        </div>
      )}
      {sub && <div className="mt-1 truncate text-2xs text-faint">{sub}</div>}
    </div>
  );
}

/** One chat's row, expandable into its individual processes. */
function ChatRow({
  chat,
  denominator,
  absolute,
  cores,
}: {
  chat: ChatResources;
  /** Bytes that count as "100%" for the bar — the machine's total. */
  denominator: number;
  absolute: boolean;
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
          <div className="truncate text-xs font-medium text-primary">
            {title ?? <span className="text-faint">{chat.chatId.slice(0, 8)}</span>}
          </div>
          <div className="mt-1 relative h-1 w-full overflow-hidden rounded-full bg-line">
            <span
              className={cn("absolute inset-y-0 left-0 rounded-full", tone(memShare))}
              style={{ width: `${memShare}%` }}
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

  // The expensive poll runs exactly while this page is mounted. Reference
  // counted in the store, so the header dropdown wanting the same data at the
  // same time still costs one scan.
  useEffect(() => subscribe(), [subscribe]);

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
          <div className="rounded-md border border-line bg-panel-2/30 px-3 py-2 text-2xs text-muted">
            <span className="font-medium text-secondary">
              {dispatch.unattributed.procs} processes
            </span>{" "}
            (≈{bytes(dispatch.unattributed.rssBytes / SHARED_PAGE_FACTOR)}) in Dispatch's tree
            belong to no chat — the server itself, sub-app runners, and anything orphaned
            mid-teardown. The DB is inside the server process, not separate.
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
          </div>
          {chats.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-faint">
              No chat is holding any processes.
            </div>
          ) : (
            chats.map((c) => (
              <ChatRow
                key={c.chatId}
                chat={c}
                denominator={system.totalBytes}
                absolute={absolute}
                cores={cores}
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
