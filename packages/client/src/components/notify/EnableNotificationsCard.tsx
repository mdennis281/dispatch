/**
 * The bottom-right "Turn on notifications" nudge.
 *
 * Asked once, and only ever from a click — see `useShouldAskToNotify`. It shares
 * the toast column with the install card and yields to it, because installing is
 * the bigger upgrade and two standing cards in one corner is a wall.
 */
import { Bell, X } from "lucide-react";
import { useBrowserNotify } from "../../lib/browserNotify.js";

export function EnableNotificationsCard() {
  const request = useBrowserNotify((s) => s.request);
  const dismiss = useBrowserNotify((s) => s.dismissAsk);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void request()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void request();
        }
      }}
      className="pointer-events-auto cursor-pointer rounded-lg border border-line-strong bg-overlay px-3 py-2.5 text-left shadow-[var(--shadow-pop)] transition-colors cm-anim-rise hover:border-accent-line hover:bg-elevated"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Bell />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium leading-snug text-primary">
            Turn on notifications
          </p>
          <p className="mt-0.5 text-xs leading-snug text-muted">
            Get pinged when an agent needs a decision while you're in another window.
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
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
