/**
 * A deterministic, in-process stand-in for the Agent SDK `query()`.
 *
 * Gated behind `CM_FAKE_SDK=1` (see container.ts) so it NEVER touches production
 * — it exists purely so the Playwright E2E can drive the full stream→store→UI
 * pipeline (user row → session init → assistant reply → result) without spawning
 * the real `claude` subprocess or depending on subscription auth / the network.
 *
 * It consumes the broker's streaming-input channel exactly like the real query:
 * for each user message pushed in, it emits an `assistant` echo + a `result`,
 * emitting the `system/init` handshake once up front. When the channel closes
 * (session stop/dispose) the async iterator ends and the broker settles `done`.
 */
import type { QueryFn } from "./session-broker.js";

let sessionSeq = 0;

/** Pull display text out of a pushed SDKUserMessage (string or text blocks). */
function userText(msg: unknown): string {
  const content = (msg as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** Build a fake `query` function the SessionBroker can consume. */
export function makeFakeQuery(): QueryFn {
  return ({ prompt }) => {
    const sessionId = `fake-session-${++sessionSeq}`;
    const input = prompt as AsyncIterable<unknown>;

    async function* stream(): AsyncGenerator<unknown> {
      let first = true;
      for await (const msg of input) {
        if (first) {
          first = false;
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            model: "claude-fake-e2e",
            permissionMode: "default",
            tools: [],
            mcp_servers: [],
          };
        }
        const text = userText(msg);
        yield {
          type: "assistant",
          uuid: `fake-msg-${sessionSeq}-${Math.random().toString(36).slice(2, 8)}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Echo: ${text}` }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          duration_ms: 3,
          total_cost_usd: 0,
          result: `Echo: ${text}`,
        };
      }
    }

    const iterator = stream();
    const q = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      return: (v?: unknown) => iterator.return(v as never),
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setMaxThinkingTokens: async () => {},
      setModel: async () => {},
      supportedCommands: async () => [],
      supportedModels: async () => [],
      mcpServerStatus: async () => ({}),
    };
    return q as unknown as ReturnType<QueryFn>;
  };
}
