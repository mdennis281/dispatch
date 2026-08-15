import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";
import { cn } from "../../lib/cn.js";
import { measureOverflow } from "../../lib/overflow.js";

export interface OverflowTooltipProps {
  text: string;
  children?: ReactNode;
  lines?: 1 | 2;
  className?: string;
}

/**
 * Ellipsized text that only pays for a tooltip when something was actually cut.
 * ResizeObserver matters here: transcript columns change width whenever a panel
 * opens, without React rendering the row again.
 */
export function OverflowTooltip({
  text,
  children,
  lines = 1,
  className,
}: OverflowTooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = measureOverflow({
        measuredWidth: measureRef.current?.scrollWidth ?? node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      });
      if (next === null) return; // skipped subtree — keep the last real answer
      setOverflowing((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, lines]);

  const content = (
    <span
      ref={ref}
      className={cn(
        "relative min-w-0",
        lines === 1 ? "block truncate" : "line-clamp-2 break-words",
        className,
      )}
    >
      {children ?? text}
      {children && lines === 1 && (
        <span
          ref={measureRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 invisible whitespace-pre cm-mono"
        >
          {text}
        </span>
      )}
    </span>
  );

  if (!overflowing) return content;
  return (
    <Tooltip
      label={text}
      side="bottom"
      triggerClassName="min-w-0 w-full max-w-full"
      className="!max-w-[min(680px,calc(100vw-24px))] !whitespace-pre-wrap cm-mono !text-2xs !font-normal"
    >
      {content}
    </Tooltip>
  );
}
