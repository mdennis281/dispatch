import { useEffect, useState, type ReactNode } from "react";
import { useConnection, type ConnState } from "../../stores/connection.js";
import {
  classifyReach,
  describeClose,
  isStaleBundle,
  type Reach,
} from "../../lib/connectionDiagnosis.js";
import { untilShort } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
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
 * Whether the socket is up, as a dot — with the details a dot cannot carry on
 * hover.
 *
 * IT USED TO BE A PILL: a bordered capsule with "Connected" in it, sitting in
 * the bar at all times. That is ~90px and a border spent on the word "yes",
 * repeating what a green dot already says — and the moment the answer is NOT
 * yes, the word was still all you got. So the dot is now the whole control, and
 * everything a pill could never fit is in the card behind it: which host this
 * tab is actually talking to, whether that is loopback, the LAN or a proxied
 * remote, the server's build, and how the socket last died.
 *
 * The HOST and REACH rows are not filler. Dispatch is normally reached through a
 * reverse proxy, where "it isn't connecting" has causes that live in the tunnel
 * rather than in the app — and the first question is always which origin the tab
 * is pointed at. That is invisible in an installed window: there is no URL bar.
 *
 * THE WORD STAYS for every state except `open`. "Reconnecting…" and "Offline"
 * are what this indicator exists for — the states that explain why nothing on
 * screen is moving — and a pulsing amber dot on its own is easy to read as
 * decoration. Only the good news is allowed to be silent.
 *
 * Not `diagnose()`, deliberately: that produces a four-check table and a
 * recommended action for `ConnectingScreen`, which is a full-window takeover
 * shown once the app has given up. This is the glance before that — same facts,
 * same vocabulary (`describeClose`, `classifyReach`), a fifth of the pixels.
 */
export function ConnectionDot({ className }: { className?: string }) {
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
      onOpenChange={setOpen}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-active",
        className,
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
                {nextRetryAt && <Row label="Next try">{untilShort(nextRetryAt, now)}</Row>}
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
      <StatusDot tone={c.tone} pulse={c.pulse} size={7} />
      {state !== "open" && (
        <span className={cn("text-xs font-medium", c.text)}>{c.label}</span>
      )}
    </HoverCard>
  );
}
