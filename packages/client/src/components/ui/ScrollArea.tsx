import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

/** A themed, thin-scrollbar overflow container. */
export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, ...rest }, ref) {
    return <div ref={ref} className={cn("cm-scroll overflow-y-auto", className)} {...rest} />;
  },
);
