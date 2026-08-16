/**
 * The standing "a new Dispatch is out" card, in the bottom-right stack beside
 * the PWA install and notification nudges.
 *
 * Not an Attention Queue item: those are chat-scoped, ranked against permission
 * prompts, and resolved by the SERVER — there is no dismiss path in that model,
 * and an update is neither about a chat nor something the server can decide has
 * been dealt with. This is the same shape as `pwa/InstallCard`, which is the
 * surface that already means "a standing, dismissable invitation".
 *
 * Unlike the install card, the whole card is NOT the button. Installing restarts
 * the app and closes every open chat view; a stray click on a card that appeared
 * under the cursor should not be able to do that.
 */
import { useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { useUpdate } from "../../stores/update.js";

export function UpdateCard() {
  const status = useUpdate((s) => s.status);
  const install = useUpdate((s) => s.install);
  const dismiss = useUpdate((s) => s.dismiss);
  const [error, setError] = useState<string | null>(null);
  const latest = status?.latest;
  if (!latest) return null;

  return (
    <div className="pointer-events-auto rounded-lg border border-accent-line/70 bg-overlay px-3 py-2.5 text-left shadow-[var(--shadow-pop)] cm-anim-rise">
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <ArrowUpCircle />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium leading-snug text-primary">
            {/* The channel is named here, not just in Settings: an unstable build
                arriving minutes after a merge is a different proposition from a
                promoted one, and the card is where most people decide. */}
            {status?.channel === "unstable" ? "Unstable update available" : "Update available"}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-muted">
            Dispatch <span className="font-mono">v{latest.version}</span> is out
            {status?.installed && (
              <>
                {" "}
                — you're on <span className="font-mono">v{status.installed.version}</span>
              </>
            )}
            . Updating stops the app and starts it again — running agents stop with it,
            and their transcripts are kept.
          </p>
          {error && <p className="mt-1 text-xs leading-snug text-danger">{error}</p>}
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                void install().then((res) => {
                  if (!res.ok) setError(res.error ?? "The update could not be started.");
                });
              }}
            >
              Update now
            </Button>
            <Button variant="link" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
        <IconButton tip="Dismiss" onClick={dismiss} className="-mr-1 -mt-0.5 shrink-0 text-faint">
          <X />
        </IconButton>
      </div>
    </div>
  );
}
