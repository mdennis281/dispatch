/**
 * The update section at the top of Settings.
 *
 * This is where a dismissed update goes to keep existing. `UpdateCard`'s
 * "Not now" silences the standing nudge, and if that were the only surface the
 * update would then be unreachable until the next release — so dismissal is
 * deliberately ignored here. Settings is the place you go when you want to know
 * what state the app is in; hiding the answer there would be the bug.
 *
 * It also renders when there is NOTHING to install, because "you are up to date,
 * checked two minutes ago" is the answer people open Settings to get. Only an
 * unsupported payload (a build run from source, no release manifest) renders
 * nothing at all — there, an update control would be a lie.
 *
 * The channel toggle lives here rather than further down Settings because the
 * three questions it answers — which stream am I on, what is on it, do I want
 * it — are one question, and splitting them puts "you are two builds behind"
 * and "…of a channel you did not mean to be on" on different screens.
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle, CheckCircle2, RefreshCw, Rocket, ShieldCheck } from "lucide-react";
import type { UpdateChannel } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { cn } from "../../lib/cn.js";
import { useUpdate, hasUpdate } from "../../stores/update.js";

/** "2 minutes ago" — good enough for a line nobody reads twice. */
function ago(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const CHANNEL_BLURB: Record<UpdateChannel, string> = {
  stable: "Tested builds, published by hand. Fewer updates, each one gated.",
  unstable: "Every merge to main, minutes after it lands. Newest, least proven.",
};

export function UpdateBanner() {
  const status = useUpdate((s) => s.status);
  const loaded = useUpdate((s) => s.loaded);
  const checking = useUpdate((s) => s.checking);
  const switching = useUpdate((s) => s.switching);
  const load = useUpdate((s) => s.load);
  const check = useUpdate((s) => s.check);
  const setChannel = useUpdate((s) => s.setChannel);
  const install = useUpdate((s) => s.install);
  const [error, setError] = useState<string | null>(null);
  // Two clicks for a step-back. It is the one action here that moves you
  // BACKWARDS through builds, and a mis-click on a segmented control should not
  // be one button away from reinstalling an older app.
  const [confirmStepBack, setConfirmStepBack] = useState(false);
  // The channel being switched TO, held locally until the server answers.
  // `status.channel` is still the old one for the whole round trip, so without
  // this the toggle springs back under the cursor as if the click missed, and
  // the progress line names the channel we are switching AWAY from.
  const [pending, setPending] = useState<UpdateChannel | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!status?.supported) return null;

  const available = hasUpdate(status);
  const channel = status.channel;
  // What the toggle and its blurb show: the target while a switch is in flight,
  // the server's answer otherwise.
  const shown = pending ?? channel;
  // "Ahead" only matters while there is a head to be ahead OF; a failed first
  // check leaves `latest` null and this must not claim anything either way.
  const ahead = status.ahead === true && status.latest !== null;

  const runInstall = (tag?: string) => {
    setError(null);
    setConfirmStepBack(false);
    void install(tag).then((res) => {
      if (!res.ok) setError(res.error ?? "The update could not be started.");
    });
  };

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        available ? "border-accent-line bg-accent-ghost" : "border-line bg-inset/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            available ? "text-accent-hi ring-accent-line" : "text-faint ring-line",
          )}
        >
          {available ? <ArrowUpCircle /> : <CheckCircle2 />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium leading-snug text-primary">
            {available ? `Dispatch v${status.latest!.version} is available` : "Dispatch is up to date"}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-faint">
            {status.installed && (
              <>
                Running <span className="font-mono">v{status.installed.version}</span> on{" "}
                {channel}
                {". "}
              </>
            )}
            {status.checkedAt ? `Checked ${ago(status.checkedAt)}.` : "Not checked yet."}
          </p>

          {ahead && (
            <p className="mt-1 text-xs leading-snug text-warn">
              This build is newer than {channel} v
              <span className="font-mono">{status.latest!.version}</span>. You'll rejoin{" "}
              {channel} at its next release, or step back to it now.
            </p>
          )}
          {status.error && <p className="mt-1 text-xs leading-snug text-warn">{status.error}</p>}
          {error && <p className="mt-1 text-xs leading-snug text-danger">{error}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {available && (
              <Button
                variant="primary"
                disabled={status.installing === true}
                onClick={() => runInstall()}
              >
                {status.installing ? "Updating…" : "Update now"}
              </Button>
            )}
            {ahead &&
              (confirmStepBack ? (
                <>
                  <Button
                    variant="danger"
                    disabled={status.installing === true}
                    onClick={() => runInstall(status.latest!.tag)}
                  >
                    {status.installing
                      ? "Installing…"
                      : `Confirm — install v${status.latest!.version}`}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmStepBack(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="default"
                  disabled={status.installing === true}
                  onClick={() => setConfirmStepBack(true)}
                >
                  Step back to {channel} v{status.latest!.version}
                </Button>
              ))}
            <Button
              variant={available ? "ghost" : "default"}
              leftIcon={<RefreshCw className={cn(checking && "cm-anim-spin")} />}
              disabled={checking || switching}
              onClick={() => void check()}
            >
              {checking ? "Checking…" : "Check now"}
            </Button>
          </div>

          <div className="mt-2.5 border-t border-line pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Channel</span>
              <SegmentedControl<UpdateChannel>
                segments={[
                  { value: "stable", label: "Stable", icon: <ShieldCheck /> },
                  { value: "unstable", label: "Unstable", icon: <Rocket /> },
                ]}
                value={shown}
                onChange={(next) => {
                  if (next === shown || switching) return;
                  setError(null);
                  setConfirmStepBack(false);
                  setPending(next);
                  // Cleared either way: on failure the toggle must fall back to
                  // whatever channel the server still says is real.
                  void setChannel(next).finally(() => setPending(null));
                }}
              />
              {switching && pending && (
                <span className="text-xs text-faint">Checking {pending}…</span>
              )}
            </div>
            <p className="mt-1 text-xs leading-snug text-faint">{CHANNEL_BLURB[shown]}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
