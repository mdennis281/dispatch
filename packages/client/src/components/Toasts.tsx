import { CheckCircle2, AlertTriangle, XCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useNotices, type NoticeLevel } from "../stores/notices.js";
import { InstallCard } from "./pwa/InstallCard.js";
import { EnableNotificationsCard } from "./notify/EnableNotificationsCard.js";
import { UpdateCard } from "./update/UpdateCard.js";
import { ResumedCard } from "./update/ResumedCard.js";
import { useShouldOfferInstall } from "../lib/pwaInstall.js";
import { useShouldAskToNotify } from "../lib/browserNotify.js";
import { useShouldNudgeUpdate } from "../stores/update.js";
import { useShouldShowResumed } from "../stores/restartResume.js";
import { cn } from "../lib/cn.js";
import { LAYER } from "../lib/layers.js";

const ICON: Record<NoticeLevel, ReactNode> = {
  info: <CheckCircle2 />,
  warn: <AlertTriangle />,
  error: <XCircle />,
};

const TONE: Record<NoticeLevel, string> = {
  info: "text-accent-hi ring-accent-line",
  warn: "text-warn ring-warn/30",
  error: "text-danger ring-danger/30",
};

/**
 * The bottom-right stack: transient toasts fed by the notices store (which the
 * WS reducer pushes `notice`/`error` events into), plus the standing PWA install
 * card underneath them. Both live in one fixed column so they can never overlap
 * — the install card is long-lived, so a toast landing on top of it would be a
 * guaranteed collision rather than a rare one.
 *
 * Reuses the overlay tokens so it matches the Popover/Modal surfaces — no new
 * design language.
 */
export function Toasts() {
  const toasts = useNotices((s) => s.toasts);
  const dismiss = useNotices((s) => s.dismiss);
  const offerInstall = useShouldOfferInstall();
  const askNotify = useShouldAskToNotify();
  const nudgeUpdate = useShouldNudgeUpdate();
  const showResumed = useShouldShowResumed();
  if (toasts.length === 0 && !offerInstall && !askNotify && !nudgeUpdate && !showResumed)
    return null;

  return (
    <div
      style={{ zIndex: LAYER.toast }}
      className="pointer-events-none fixed bottom-4 right-4 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line-strong bg-overlay px-3 py-2.5 shadow-[var(--shadow-pop)] cm-anim-rise"
        >
          <span
            className={cn(
              "mt-px flex size-5 shrink-0 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
              TONE[t.level],
            )}
          >
            {ICON[t.level]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-base leading-snug text-primary">{t.text}</p>
            {t.detail && (
              <p className="mt-0.5 break-words text-xs leading-snug text-muted">{t.detail}</p>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-faint transition-colors hover:text-secondary [&_svg]:size-3.5"
          >
            <X />
          </button>
        </div>
      ))}
      {/* One standing card at a time. An available update outranks both nudges:
          it is the only one that goes stale, and the other two will still be
          true after the restart. */}
      {/* Outranks all three nudges. It is the only one reporting something that
          ALREADY happened, unprompted, and whose undo stops being useful the
          longer the resumed turns run. The others will still be true later. */}
      {showResumed ? (
        <ResumedCard />
      ) : nudgeUpdate ? (
        <UpdateCard />
      ) : offerInstall ? (
        <InstallCard />
      ) : askNotify ? (
        <EnableNotificationsCard />
      ) : null}
    </div>
  );
}
