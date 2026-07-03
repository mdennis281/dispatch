import { CheckCircle2, AlertTriangle, XCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useNotices, type NoticeLevel } from "../stores/notices.js";
import { cn } from "../lib/cn.js";

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
 * Bottom-right transient toast stack, fed by the notices store (which the WS
 * reducer pushes `notice`/`error` events into). Reuses the overlay tokens so it
 * matches the Popover/Modal surfaces — no new design language.
 */
export function Toasts() {
  const toasts = useNotices((s) => s.toasts);
  const dismiss = useNotices((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
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
            <p className="text-[12.5px] leading-snug text-primary">{t.text}</p>
            {t.detail && (
              <p className="mt-0.5 break-words text-[11px] leading-snug text-muted">{t.detail}</p>
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
    </div>
  );
}
