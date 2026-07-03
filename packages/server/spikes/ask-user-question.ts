/**
 * Spike — how AskUserQuestion surfaces (CONFIRMED live, SDK 0.3.199).
 *
 * Finding: AskUserQuestion surfaces BOTH as a `tool_use` block in the assistant
 * stream AND as a `canUseTool("AskUserQuestion", { questions:[…] }, …)` call.
 * It is NOT routed through `onUserDialog` (that `request_user_dialog` /
 * `permission_ask_user_question` dialog is only emitted to a client that
 * declares `supportedDialogKinds` AND does not answer over canUseTool first).
 *
 * The answer is fed back to the model as the canUseTool ALLOW result with an
 * `answers` map merged onto the ORIGINAL input (question text → chosen label):
 *
 *   { behavior: "allow", updatedInput: { ...input, answers: { [q]: label } } }
 *
 * Return the input WITHOUT `answers` and the CLI tool_result is literally
 * "The user did not answer the questions." — the bug this spike pinned down.
 * With `answers`, the tool_result is "Your questions have been answered: …" and
 * the model continues. This is exactly what SessionBroker.answerQuestion builds.
 *
 * Run: pnpm --filter @cm/server exec tsx spikes/ask-user-question.ts
 */
import { query, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.log("[askq]", ...a);

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
  const dir = mkdtempSync(join(tmpdir(), "cm-askq-"));
  const input = new InputChannel();

  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
    log("canUseTool <-", toolName, "| keys:", Object.keys(toolInput).join(","));
    if (toolName === "AskUserQuestion") {
      const questions = (toolInput.questions ?? []) as { question: string; options?: { label: string }[] }[];
      const answers: Record<string, string> = {};
      for (const qn of questions) answers[qn.question] = qn.options?.[0]?.label ?? "Yes"; // pick first option
      log("  >> answering via updatedInput.answers:", JSON.stringify(answers));
      return { behavior: "allow", updatedInput: { ...toolInput, answers } };
    }
    return { behavior: "allow", updatedInput: toolInput };
  };

  const q = query({
    prompt: input,
    options: { cwd: dir, settingSources: [], permissionMode: "default", canUseTool, maxTurns: 12 },
  });

  input.push(
    "Before doing anything, use the AskUserQuestion tool to ask me ONE question: " +
    "'Which language do you prefer?' with options TypeScript and JavaScript. " +
    "After I answer, just tell me my choice in one sentence."
  );

  for await (const msg of q) {
    const m = msg as any;
    if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") log("tool_use block:", b.name);
        if (b.type === "text" && b.text?.trim()) log("assistant text:", b.text.trim().slice(0, 160));
      }
    } else if (m.type === "user") {
      for (const b of m.message?.content ?? []) {
        if (b?.type === "tool_result") log("tool_result:", JSON.stringify(b.content).slice(0, 200));
      }
    } else if (m.type === "result") {
      log("result:", m.subtype, "| is_error:", m.is_error);
      input.close();
    }
  }
  log("=== DONE ===");
}

void main().catch((e) => { console.error("[askq] FAILED:", e); process.exitCode = 1; });
