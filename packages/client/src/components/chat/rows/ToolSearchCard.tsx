import { memo } from "react";
import { PackageSearch, X } from "lucide-react";
import type { ToolResultRow, ToolUseRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { parseMcpName } from "../../../lib/format.js";
import { displayResultText } from "../../../lib/toolPresentations.js";
import { parseToolSearchCall, toolSearchMatches } from "../../../lib/toolSearch.js";

/** One loaded tool: the MCP server faint, the tool itself in full. */
function ToolName({ name }: { name: string }) {
  const mcp = parseMcpName(name);
  return (
    <span
      title={name}
      className="inline-flex min-w-0 items-center gap-1 rounded-[4px] border border-line-soft bg-inset px-1.5 py-0.5 cm-mono !text-2xs"
    >
      {mcp ? (
        <>
          <span className="truncate text-faint">{mcp.server}</span>
          <span className="text-faint">›</span>
          <span className="truncate text-secondary">{mcp.tool}</span>
        </>
      ) : (
        <span className="truncate text-secondary">{name}</span>
      )}
    </span>
  );
}

/**
 * A ToolSearch call as one line: what it asked for, what it loaded.
 *
 * Nothing here is worth expanding — the arguments ARE the names and the result
 * IS the names — so unlike ToolCallCard there is no disclosure at all. Only a
 * result we can't read as `tool_reference`s (an error, "no match" prose) gets a
 * second line, and that line is the text itself.
 */
export const ToolSearchCard = memo(function ToolSearchCard({
  use,
  result,
}: {
  use: ToolUseRow;
  result?: ToolResultRow;
}) {
  const call = parseToolSearchCall(use);
  const running = !result;
  const errored = !!result && (result.isError || result.ok === false);
  const matches = result && !errored ? toolSearchMatches(result.content) : null;
  // While running, a select: already knows what it will load; show that.
  const names = matches ?? (running ? (call?.requested ?? []) : []);
  const note = result && (errored || matches === null) ? displayResultText(result.content) : "";
  const empty = !!result && !errored && matches?.length === 0;

  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-panel-2 text-secondary ring-1 ring-line [&_svg]:size-3.5">
          <PackageSearch />
        </span>
      }
    >
      <div className="rounded-md border border-line bg-panel-2/60 px-2.5 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 text-sm font-semibold text-primary">
            {call?.mode === "search" ? "Searched tools" : "Loaded tools"}
          </span>
          {call?.mode === "search" && (
            <span className="min-w-0 truncate cm-mono !text-xs text-muted">“{call.query}”</span>
          )}
          {names.length > 0 && (
            <span className={cn("flex min-w-0 flex-wrap items-center gap-1", running && "opacity-60")}>
              {names.map((name) => (
                <ToolName key={name} name={name} />
              ))}
            </span>
          )}
          {empty && <span className="text-xs text-faint">no matches</span>}
          <span className="ml-auto flex shrink-0 items-center pl-2">
            {running ? (
              <Chip tone="accent" icon={<Spinner size={9} />}>
                loading
              </Chip>
            ) : errored ? (
              <Chip tone="danger" icon={<X />}>
                failed
              </Chip>
            ) : null}
          </span>
        </div>
        {note && (
          <p
            className={cn(
              "mt-1 whitespace-pre-wrap break-words text-xs",
              errored ? "text-danger" : "text-muted",
            )}
          >
            {note}
          </p>
        )}
      </div>
    </RowShell>
  );
});
