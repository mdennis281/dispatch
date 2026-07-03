/**
 * Phase 0 spike #3 — permission mechanics. The Bash-echo case was auto-allowed via the
 * working-dir/safety path (never reached "ask"). This proves canUseTool DOES fire for a
 * genuinely-gated action (Write), that ALLOW and DENY both work, and that the callback
 * hands us pre-rendered prompt text (title/displayName) for the UI cards.
 *
 * Run: pnpm --filter @cm/server exec tsx spikes/permission.ts
 */
import { query, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.log("[spike3]", ...a);

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
  close() { this.closed = true; let w; while ((w = this.waiting.shift())) w({ value: undefined as never, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => {
      const m = this.queued.shift();
      if (m) return Promise.resolve({ value: m, done: false });
      if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((res) => this.waiting.push(res));
    }};
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "cm-spike3-"));
  const input = new InputChannel();
  let calls = 0;
  const seen: { tool: string; title?: string; displayName?: string; decision: string }[] = [];

  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, opts: any): Promise<PermissionResult> => {
    calls++;
    const decision = calls === 1 ? "allow" : "deny";
    seen.push({ tool: toolName, title: opts?.title, displayName: opts?.displayName, decision });
    log(`canUseTool #${calls} <-`, toolName, "| title:", opts?.title ?? "(none)", "| reason:", opts?.decisionReason ?? "(none)");
    return decision === "allow"
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "Denied by spike policy." };
  };

  const q = query({
    prompt: input,
    options: { cwd: dir, settingSources: [], permissionMode: "default", canUseTool, disallowedTools: ["Bash"], maxTurns: 12 },
  });

  input.push("Create a file named note.txt containing the text HELLO. Use the Write tool.");

  let turns = 0;
  for await (const msg of q) {
    const m = msg as any;
    if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") log("tool_use:", b.name);
      }
    } else if (m.type === "result") {
      turns++;
      log(`turn ${turns}:`, m.subtype);
      if (turns === 1) input.push("Now create a file named secret.txt containing NOPE. Use the Write tool.");
      else input.close();
    }
  }

  const noteExists = existsSync(join(dir, "note.txt"));
  const secretExists = existsSync(join(dir, "secret.txt"));
  log("RESULT:", {
    canUseToolFired: calls > 0,
    calls,
    seen,
    noteExists_shouldBeTrue: noteExists,
    secretExists_shouldBeFalse: secretExists,
  });
  const pass = calls >= 1 && noteExists && !secretExists;
  if (pass) log("=== PERMISSION ALLOW+DENY PROVEN ===");
  else { console.error("[spike3] FAIL: permission gating not as expected"); process.exitCode = 1; }
}

void main().catch((e) => { console.error("[spike3] FAILED:", e); process.exitCode = 1; });
