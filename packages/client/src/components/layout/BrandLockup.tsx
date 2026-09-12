import { useEffect, useState, type ReactNode } from "react";
import { useConnection, type ConnState } from "../../stores/connection.js";
import {
  classifyReach,
  describeClose,
  isStaleBundle,
  type Reach,
} from "../../lib/connectionDiagnosis.js";
import { countdown } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { HoverCard } from "../ui/HoverCard.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";

export const CONN_META: Record<ConnState, { tone: DotTone; label: string; pulse: boolean; text: string }> = {
  open: { tone: "success", label: "Connected", pulse: false, text: "text-secondary" },
  connecting: { tone: "warn", label: "Connecting…", pulse: true, text: "text-warn" },
  reconnecting: { tone: "warn", label: "Reconnecting…", pulse: true, text: "text-warn" },
  closed: { tone: "muted", label: "Offline", pulse: false, text: "text-muted" },
};

const REACH_WORD: Record<Reach, string> = {
  loopback: "this machine",
  lan: "local network",
  remote: "remote",
};

/** One `label — value` line in the card. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-1">
      <span className="shrink-0 text-2xs text-faint">{label}</span>
      <span className="cm-mono truncate text-2xs text-secondary">{children}</span>
    </div>
  );
}

/**
 * The brand, and whether it is connected — one control.
 *
 * ── WHERE THE DOT GOES ───────────────────────────────────────────────────────
 *
 * The connection used to be a pill ("Connected", in a bordered capsule), then a
 * bare dot with a strip of the title bar to itself — a 7px circle alone at the
 * far left of an 800px band, reading as a stray pixel rather than as the app's
 * pulse. It belongs WITH the brand, since "is Dispatch there" is a fact about
 * Dispatch, but NOT IN the mark: it was tried lighting the mark's junction node,
 * and a green node inside the logo reads as the logo recoloured, not as a
 * status beside it. So it ends the wordmark: "Dispatch ●".
 *
 * `tall` is the installed window's lockup, spanning both lines of the title bar
 * with the mark at 48px. It does NOT print the host under the wordmark: that was
 * tried, and an address permanently in the corner of the app is noise — it is
 * one hover away, in the card.
 *
 * THE WORD STAYS for every state except `open`, after the dot. "Reconnecting…"
 * and "Offline" are what this indicator exists for, and an amber dot on its own
 * is easy to read as the brand's own colour. Only the good news is silent.
 *
 * ── THE CARD ─────────────────────────────────────────────────────────────────
 *
 * Everything a dot could never carry: which host this tab is talking to, whether
 * that is loopback, the LAN or a proxied remote, the server's build, and how the
 * socket last died. Not `diagnose()`, deliberately: that is `ConnectingScreen`'s
 * four-check table for once the app has given up. This is the glance before
 * that — same vocabulary (`describeClose`, `classifyReach`), a fifth of the
 * pixels.
 *
 * It opens on a DELAY (see `HoverCard.openDelay`), unlike the gauges: this is the
 * top-left corner of the app, which the pointer crosses on its way to the
 * sidebar constantly.
 */
export type LockupSize = "tall" | "row" | "mark";

export function BrandLockup({ size }: { size: LockupSize }) {
  const state = useConnection((s) => s.state);
  const attempts = useConnection((s) => s.attempts);
  const nextRetryAt = useConnection((s) => s.nextRetryAt);
  const lastClose = useConnection((s) => s.lastClose);
  const serverVersion = useConnection((s) => s.serverVersion);
  const online = useConnection((s) => s.online);

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The retry countdown is the only live number in the card, so it ticks only
  // while the card is open — and only while there is a retry to count down to.
  // It counts in SECONDS (`countdown`, not `untilShort`): the backoff is capped
  // at 10s, so a minute-granularity readout would print "<1m" for the whole
  // reconnect and this interval would re-render a constant once a second.
  useEffect(() => {
    if (!open || !nextRetryAt) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [open, nextRetryAt]);

  const c = CONN_META[state];
  const host = typeof location === "undefined" ? "" : location.host;
  const reach = classifyReach(typeof location === "undefined" ? "" : location.hostname);
  const clientVersion = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "dev";
  const stale = isStaleBundle(clientVersion, serverVersion);

  return (
    <HoverCard
      label={`Connection: ${c.label}`}
      width={252}
      openDelay={300}
      onOpenChange={setOpen}
      className={cn(
        "flex shrink-0 items-center rounded-md text-left",
        size === "tall" ? "gap-2.5 pl-2 pr-3" : "gap-2 pr-1",
      )}
      card={() => (
        <>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
            <StatusDot tone={c.tone} pulse={c.pulse} size={6} />
            <span className={cn("text-xs font-semibold tracking-tight", c.text)}>{c.label}</span>
          </div>

          <div className="py-1">
            <Row label="Host">{host || "—"}</Row>
            <Row label="Reach">{REACH_WORD[reach]}</Row>
            {/* A source checkout sends no version in `hello`; saying so beats a
                blank row, which reads as a failed lookup. */}
            <Row label="Server">{serverVersion ?? "source checkout"}</Row>
            {state === "open" ? (
              <Row label="Socket">open</Row>
            ) : (
              <>
                <Row label="Socket">{describeClose(lastClose)}</Row>
                {nextRetryAt && <Row label="Next try">{countdown(nextRetryAt, now)}</Row>}
                {attempts > 0 && <Row label="Attempts">{attempts}</Row>}
                {!online && <Row label="Network">browser reports offline</Row>}
              </>
            )}
          </div>

          {/* Only when the two builds genuinely differ: this tab is running code
              the server has replaced, which is the quiet failure where
              everything looks fine and new events stop being understood. */}
          {stale && (
            <div className="border-t border-line bg-warn-ghost px-3 py-1.5 text-2xs text-warn">
              This tab is running {clientVersion} — reload to pick up {serverVersion}.
            </div>
          )}
        </>
      )}
    >
      <DispatchMark className={cn("shrink-0", size === "tall" ? "size-12" : "size-8")} />

      {/* The wordmark drops on a phone: the mark is the same brand in a quarter
          of the width, and on a home-screen PWA the app's name is already under
          the icon you tapped. */}
      {size === "tall" && (
        <span className="text-xl font-semibold tracking-tight text-primary">Dispatch</span>
      )}
      {size === "row" && (
        <span className="text-base font-semibold tracking-tight text-primary">Dispatch</span>
      )}
      <StatusDot tone={c.tone} pulse={c.pulse} size={size === "tall" ? 8 : 7} />
      {state !== "open" && (
        <span className={cn("text-xs font-medium", c.text)}>{c.label}</span>
      )}
    </HoverCard>
  );
}
