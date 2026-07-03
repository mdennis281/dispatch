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
