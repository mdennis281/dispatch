/**
 * `chat_tree` — a chat's family as the sidebar nests it. The data and the
 * rendering live in services/chat-tree.ts; this is only the tool, kept out of
 * manager-mcp.ts for the same reason attention-tools.ts is.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { renderChatTree, type ChatTree } from "../chat-tree.js";
import type { ManagerToolDefinition } from "./manager-mcp.js";

/** The family lookup (omitted → no `chat_tree`). Null for an unknown/invisible chat. */
export interface ManagerMcpChatTree {
  tree(chatId: string, depth: number): Promise<ChatTree | null>;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

const shape = {
  chatId: z.string().describe("Any chat in the family, as reported by chat_find."),
  depth: z.number().int().min(1).max(5).optional().describe("Levels of descendants to include (default 3)."),
};

export function createChatTreeTools(ctx: { chatTree?: ManagerMcpChatTree }) {
  const chatTreeTool: ManagerToolDefinition<typeof shape> = {
    name: "chat_tree",
    description:
      "A chat's FAMILY, as the sidebar nests it: the chats above it up to the root, and below " +
      "it the chats it spawned and the reviewer chats pointed at its pull requests — each with " +
      "status, whether it waits on the human, and when it last moved. Use it to see everything " +
      "a parent chat set in motion, or to find which chat started this one.",
    inputSchema: shape,
    handler: async (args) => {
      if (!ctx.chatTree) return textResult("The chat_tree tool is not available in this session.", true);
      const chatId = args.chatId.trim();
      if (!chatId) return textResult("chat_tree requires a non-empty chatId.", true);
      try {
        const tree = await ctx.chatTree.tree(chatId, args.depth ?? 3);
        if (!tree) return textResult(`No chat "${chatId}" exists. Find the right id with chat_find.`, true);
        return textResult(`${renderChatTree(tree)}\n${JSON.stringify(tree)}`);
      } catch (err) {
        return textResult(`Could not read the chat tree: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  };
  return { chatTree: chatTreeTool };
}
