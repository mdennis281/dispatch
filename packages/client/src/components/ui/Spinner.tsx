import { cn } from "../../lib/cn.js";

/** A minimal ring spinner. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border-[1.5px] border-line-strong border-t-accent cm-anim-spin",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label="loading"
    />
  );
}

/**
 * How far a download has got: a ring that fills when `progress` (0–1) is known,
 * the plain {@link Spinner} when it isn't — a server that sent no length, or a
 * request that hasn't answered yet. Never a fake determinate ring; one that
 * crawls to 90% and sits there is worse than an honest spinner.
 */
export function ProgressRing({
  progress,
  size = 28,
  className,
}: {
  progress?: number;
  size?: number;
  className?: string;
}) {
  if (progress === undefined) return <Spinner size={size} className={className} />;
  const pct = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <span
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label="loading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-line-strong"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="stroke-accent transition-[stroke-dashoffset] duration-200"
        />
      </svg>
      {size >= 28 && (
        <span className="cm-mono absolute !text-2xs text-muted">{pct}</span>
      )}
    </span>
  );
}

/** Three-dot "agent is typing" pulse. */
export function TypingPulse({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-label="typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-accent cm-typing-dot"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}
