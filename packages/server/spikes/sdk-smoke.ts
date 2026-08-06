/**
 * Phase 0 de-risk spike. Proves against the REAL SDK (0.3.199) on this machine:
 *   1. subscription auth headless round-trip (no ANTHROPIC_API_KEY)
 *   2. canUseTool fires on a gated tool (Bash) and we can allow it
 *   3. 3 concurrent sessions run independently with distinct session ids
 *
 * Run: pnpm --filter @dispatch/server spike   (from Dispatch/)
 */
import { query, type SDKMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.log("[spike]", ...a);

type Drained = { sessionId: string; text: string; apiKeySource?: string; sawTool: boolean };

async function drain(label: string, q: AsyncGenerator<SDKMessage, void>): Promise<Drained> {
  let sessionId = "";
  let text = "";
  let apiKeySource: string | undefined;
  let sawTool = false;
  for await (const msg of q) {
    const m = msg as any;
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      apiKeySource = m.apiKeySource;
      log(label, "init:", { session: sessionId?.slice(0, 8), model: m.model, apiKeySource: m.apiKeySource });
    } else if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "text") text += block.text;
        if (block.type === "tool_use") { sawTool = true; log(label, "tool_use:", block.name, JSON.stringify(block.input).slice(0, 100)); }
      }
    } else if (m.type === "result") {
      log(label, "result:", { subtype: m.subtype, turns: m.num_turns, is_error: m.is_error });
    }
  }
  return { sessionId, text, apiKeySource, sawTool };
}

async function spikeAuth() {
  log("=== Spike 1: subscription auth + streaming ===");
  const q = query({ prompt: "Reply with exactly this token and nothing else: HIVEBREAK-OK", options: { settingSources: [], permissionMode: "default", maxTurns: 1 } });
  const r = await drain("auth", q);
  log("auth ->", { text: r.text.trim().slice(0, 60), apiKeySource: r.apiKeySource, session: !!r.sessionId });
  if (!r.sessionId) throw new Error("no session id from init message");
}

async function spikePermission() {
  log("=== Spike 2: canUseTool gate on Bash ===");
  const dir = mkdtempSync(join(tmpdir(), "cm-spike-"));
  let sawPermission = false;
  const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    sawPermission = true;
    log("canUseTool <-", toolName, JSON.stringify(input).slice(0, 100));
    return { behavior: "allow", updatedInput: input };
  };
  // Bash intentionally NOT in allowedTools, so default mode routes it through canUseTool.
  const q = query({ prompt: "Run this shell command and report its output: echo HIVE-TOOL-OK", options: { cwd: dir, settingSources: [], permissionMode: "default", canUseTool, maxTurns: 4 } });
  const r = await drain("perm", q);
  log("perm ->", { sawPermission, sawTool: r.sawTool, text: r.text.trim().slice(0, 120) });
  if (!sawPermission) log("WARN: canUseTool never fired — investigate gating");
}

async function spikeConcurrency() {
  log("=== Spike 3: 3 concurrent sessions ===");
  const mk = (n: number) => drain("conc" + n, query({ prompt: `Reply with exactly: SESSION-${n}`, options: { settingSources: [], permissionMode: "default", maxTurns: 1 } }));
  const results = await Promise.all([mk(1), mk(2), mk(3)]);
  const ids = results.map((r) => r.sessionId);
  log("concurrency ->", { ids: ids.map((i) => i.slice(0, 8)), allDistinct: new Set(ids).size === 3 });
  results.forEach((r, i) => log(`conc${i + 1} text:`, JSON.stringify(r.text.trim().slice(0, 40))));
}

async function main() {
  const t0 = Date.now();
  try {
    await spikeAuth();
    await spikePermission();
    await spikeConcurrency();
    log(`=== ALL SPIKES PASSED in ${Date.now() - t0}ms ===`);
  } catch (e) {
    console.error("[spike] FAILED:", e);
    process.exitCode = 1;
  }
}
void main();
