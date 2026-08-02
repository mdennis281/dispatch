import type { ReactNode } from "react";
import {
  Terminal,
  Plug,
  FileText,
  FilePen,
  Wrench,
  Globe,
  Search,
  ClipboardList,
} from "lucide-react";
import { parseMcpName } from "../../lib/format.js";

/**
 * Glyph for a tool name. Shared so a tool reads the same everywhere it appears —
 * the chat's ToolCallCard and the agent-run inspector's timeline.
 */
export function toolIcon(name: string): ReactNode {
  const mcp = parseMcpName(name);
  if (mcp) {
    if (/navig|open|url|goto/i.test(mcp.tool)) return <Globe />;
    if (/find|search|query/i.test(mcp.tool)) return <Search />;
    return <Plug />;
  }
  if (name === "Bash" || name === "PowerShell") return <Terminal />;
  if (name === "Read" || name === "Grep" || name === "Glob") return <FileText />;
  if (name === "Write" || name === "Edit") return <FilePen />;
  if (name === "ExitPlanMode" || name === "EnterPlanMode") return <ClipboardList />;
  return <Wrench />;
}
