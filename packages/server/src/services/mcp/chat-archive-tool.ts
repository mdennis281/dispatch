/**
 * `chat_archive` — archive or restore a chat WITHOUT stopping it.
 *
 * `chat_stop { archive: true }` is "call it off and put it away": it interrupts
 * the turn and releases the session first. A connector tidying up a chat that
 * finished an hour ago wanted neither, and had no way at all to bring an
 * archived chat back. The rule on WHICH chats it may archive lives in
 * `ChannelChatService.setArchived`, beside the stop path that shares it.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ManagerToolDefinition } from "./manager-mcp.js";

export interface ManagerMcpArchiveResult {
  chatId: string;
  title: string;
  archived: boolean;
  /** False when the chat was already in the asked state. */
  changed: boolean;
}

/** Bound beside `chat_stop` on the integration mount (omitted → no `chat_archive`). Throws a sentence. */
export interface ManagerMcpChatArchive {
  setArchived(chatId: string, archived: boolean): Promise<ManagerMcpArchiveResult>;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

const shape = {
  chatId: z.string().describe("The chat, as reported by chat_find."),
  archived: z.boolean().describe("true to archive, false to restore it to the sidebar."),
};

export function createChatArchiveTools(ctx: { archive?: ManagerMcpChatArchive }) {
  const chatArchive: ManagerToolDefinition<typeof shape> = {
    name: "chat_archive",
    description:
      "Archive a chat (hide it from the sidebar) or restore one — WITHOUT interrupting it or " +
      "releasing its session; use chat_stop to call a running chat off. Archiving is allowed only " +
      "for a chat you started; restoring works on any chat you can see. Find archived chats with " +
      "chat_find archived:true.",
    inputSchema: shape,
    handler: async (args) => {
      if (!ctx.archive) return textResult("The chat_archive tool is not available in this session.", true);
      const chatId = args.chatId.trim();
      if (!chatId) return textResult("chat_archive requires a non-empty chatId.", true);
      try {
        const r = await ctx.archive.setArchived(chatId, args.archived);
        const verb = r.archived ? "archived" : "restored to the sidebar";
        return textResult(`${r.changed ? "" : "Already "}${verb}: ${r.chatId} "${r.title}".\n${JSON.stringify(r)}`);
      } catch (err) {
        return textResult(`Could not ${args.archived ? "archive" : "restore"} it: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  };
  return { chatArchive };
}
