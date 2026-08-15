/**
 * The update row at the top of Settings.
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
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "../ui/Button.js";
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

export function UpdateBanner() {
  const status = useUpdate((s) => s.status);
  const loaded = useUpdate((s) => s.loaded);
  const checking = useUpdate((s) => s.checking);
  const load = useUpdate((s) => s.load);
  const check = useUpdate((s) => s.check);
  const install = useUpdate((s) => s.install);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!status?.supported) return null;

  const available = hasUpdate(status);

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
                Running <span className="font-mono">v{status.installed.version}</span>
                {". "}
              </>
            )}
            {status.checkedAt ? `Checked ${ago(status.checkedAt)}.` : "Not checked yet."}
          </p>
          {status.error && (
            <p className="mt-1 text-xs leading-snug text-warn">{status.error}</p>
          )}
          {error && <p className="mt-1 text-xs leading-snug text-danger">{error}</p>}
          <div className="mt-2 flex items-center gap-2">
            {available && (
              <Button
                variant="primary"
                disabled={status.installing === true}
                onClick={() => {
                  setError(null);
                  void install().then((res) => {
                    if (!res.ok) setError(res.error ?? "The update could not be started.");
                  });
                }}
              >
                {status.installing ? "Updating…" : "Update now"}
              </Button>
            )}
            <Button
              variant={available ? "ghost" : "default"}
              leftIcon={<RefreshCw className={cn(checking && "cm-anim-spin")} />}
              disabled={checking}
              onClick={() => void check()}
            >
              {checking ? "Checking…" : "Check now"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
