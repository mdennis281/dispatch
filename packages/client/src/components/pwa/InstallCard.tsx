/**
 * The bottom-right "Install Dispatch" card.
 *
 * Shown only when the browser has actually offered an install (see
 * `lib/pwaInstall.ts` — no offer, no card), so it can promise a real one-click
 * install rather than talking you through Chrome's address-bar menu. It rides in
 * the same bottom-right stack as the toasts, below them, because a transient
 * "Settings saved" should sit above a standing invitation.
 *
 * The whole card is the button: the ask says clicking installs, so clicking
 * anywhere but "Not now" installs.
 */
import { Download, X } from "lucide-react";
import { usePwaInstall, useShouldOfferInstall } from "../../lib/pwaInstall.js";

export function InstallCard() {
  const offer = useShouldOfferInstall();
  const install = usePwaInstall((s) => s.install);
  const snooze = usePwaInstall((s) => s.snooze);
  if (!offer) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void install()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void install();
        }
      }}
      className="pointer-events-auto cursor-pointer rounded-lg border border-accent-line/70 bg-overlay px-3 py-2.5 text-left shadow-[var(--shadow-pop)] transition-colors cm-anim-rise hover:border-accent-line hover:bg-elevated"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Download />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium leading-snug text-primary">
            Install Dispatch
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">
            Click to install as an app — its own window, taskbar icon, and desktop
            notifications while agents run.
          </p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              snooze();
            }}
            className="mt-1.5 text-[11px] font-medium text-faint underline-offset-2 transition-colors hover:text-secondary hover:underline"
          >
            Not now
          </button>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            snooze();
          }}
          aria-label="Dismiss"
          className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-faint transition-colors hover:text-secondary [&_svg]:size-3.5"
        >
          <X />
        </button>
      </div>
    </div>
  );
}
