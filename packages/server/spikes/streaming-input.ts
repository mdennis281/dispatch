/**
 * Phase 0 spike #2 — the interactive core. Proves in STREAMING INPUT mode:
 *   1. canUseTool fires on a gated tool (the single-shot spike showed it does NOT in string mode)
 *   2. multi-message input works — push a 2nd message after turn 1 completes (mid-run steering primitive)
 *   3. Query.interrupt() is available
 *
 * Run: pnpm --filter @cm/server exec tsx spikes/streaming-input.ts
 */
import { query, type SDKMessage, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.log("[spike2]", ...a);

/** An async-iterable input channel we can push to over time and close. This is the
 *  exact shape SessionBroker will use to feed + steer a live session. */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queued: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(text: string) {
    const msg = { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } as unknown as SDKUserMessage;
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false });
    else this.queued.push(msg);
  }
  close() {
    this.closed = true;
    let w;
    while ((w = this.waiting.shift())) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queued.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiting.push(res));
      },
    };
  }
}

async function main() {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "cm-spike2-"));
  const input = new InputChannel();
  let sawPermission = false;
  const permittedTools: string[] = [];

  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
    sawPermission = true;
    permittedTools.push(toolName);
    log("canUseTool <-", toolName, JSON.stringify(toolInput).slice(0, 90));
    return { behavior: "allow", updatedInput: toolInput };
  };

  const q = query({
    prompt: input,
    options: { cwd: dir, settingSources: [], permissionMode: "default", canUseTool, maxTurns: 12 },
  });

  log("interrupt available:", typeof q.interrupt === "function");
  input.push("Use the Bash tool to run exactly: echo STREAM-TOOL-OK");

  let turns = 0;
  let text = "";
  for await (const msg of q) {
    const m = msg as any;
    if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "text") text += b.text;
        if (b.type === "tool_use") log("tool_use:", b.name, JSON.stringify(b.input).slice(0, 90));
      }
    } else if (m.type === "result") {
      turns++;
      log(`turn ${turns} complete:`, { subtype: m.subtype, num_turns: m.num_turns });
      if (turns === 1) {
        log(">> pushing a 2nd message (mid-run steering primitive)");
        input.push("Now use the Bash tool to run exactly: echo SECOND-TURN-OK");
      } else {
        input.close();
      }
    }
  }

  log("RESULT:", {
    sawPermission,
    permittedTools,
    turns,
    ok: sawPermission && turns >= 2,
    elapsedMs: Date.now() - t0,
  });
  if (!sawPermission) {
    console.error("[spike2] FAIL: canUseTool still did not fire in streaming mode");
    process.exitCode = 1;
  } else {
    log("=== STREAMING INTERACTIVE CORE PROVEN ===");
  }
}

void main().catch((e) => {
  console.error("[spike2] FAILED:", e);
  process.exitCode = 1;
});
