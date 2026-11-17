import type { ReactNode } from "react";
import type { ToolResultRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ResultMediaStrip } from "./ResultMediaStrip.js";
import { Chip } from "../../ui/Chip.js";
import type { ToolCallState } from "../../../lib/toolState.js";

/**
 * The frame around a run of adjacent calls to one surface: the gutter icon, a
 * header naming the surface with a step count and one status chip for the
 * whole run, the step rows, and any media the steps returned.
 *
 * The pull-request and issue groups each carried this markup verbatim. When a
 * third surface gets grouped, it should look the same without a third copy.
 */
export function RunGroupCard({
  icon,
  title,
  states,
  chatId,
  results,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** One per step. Running wins over failed, which wins over ok. */
  states: ToolCallState[];
  chatId: string;
  results: (ToolResultRow | undefined)[];
  children: ReactNode;
}) {
  const running = states.includes("running");
  const failed = states.includes("failed");
  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-info-ghost text-info-hi ring-1 ring-info-line [&_svg]:size-3.5">
          {icon}
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex h-8 items-center gap-2 border-b border-line-soft px-2.5">
          <span className="text-sm font-semibold text-primary">{title}</span>
          <span className="cm-mono !text-2xs text-faint">
            {states.length} step{states.length === 1 ? "" : "s"}
          </span>
          <span className="ml-auto">
            <Chip tone={running ? "accent" : failed ? "danger" : "success"}>
              {running ? "working" : failed ? "failed" : "ok"}
            </Chip>
          </span>
        </div>
        <div>{children}</div>
        <ResultMediaStrip chatId={chatId} results={results} />
      </div>
    </RowShell>
  );
}
