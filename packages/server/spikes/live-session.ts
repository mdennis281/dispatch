/**
 * Phase 1 verification — REAL end-to-end through the built backend.
 * Drives an actual Claude turn through the real SessionBroker + Store + EventBus
 * (the compiled dist, exactly as `node dist/index.js` runs) and asserts:
 *   - the assistant actually replies (subscription auth, streaming loop)
 *   - domain events flow onto the bus
 *   - the transcript is persisted to the filesystem Store
 *
 * Run (after building): pnpm --filter @dispatch/server exec tsx spikes/live-session.ts
 */
import { SessionBroker } from "../dist/services/session-broker.js";
import { Store } from "../dist/store/index.js";
import { EventBus } from "../dist/bus.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (...a: unknown[]) => console.log("[live]", ...a);

async function waitUntil(pred: () => boolean, ms: number, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`(timeout waiting for ${label} after ${ms}ms — evaluating on what arrived)`);
  return false;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "cm-live-"));
  const store = new Store(dataDir);
  await store.init();
  const bus = new EventBus();
  const broker = new SessionBroker({ store, bus });

  const events: any[] = [];
  bus.subscribe((e) => events.push(e));

  const chat: any = {
    id: "chat-live-1",
    projectId: "p1",
    title: "Live smoke",
    modeId: "default",
    effort: "low",
    worktrees: [],
    prs: [],
    createdAt: Date.now(),
  };
  await store.saveChat(chat);

  broker.create(chat);
  log("session created; sending a message to real Claude…");
  await broker.sendMessage(chat.id, "Reverse the word HELLO and reply with ONLY the result in uppercase.");

  await waitUntil(
    () =>
      events.some((e) => e.type === "chat-message" && e.message.kind === "result") ||
      events.some((e) => e.type === "chat-status" && ["idle", "done", "error"].includes(e.status)),
    120_000,
    "turn completion (result / idle status)",
  );
  // settle so trailing result/status/persist events land
  await new Promise((r) => setTimeout(r, 1500));

  const blob = JSON.stringify(events);
  const msgs = events.filter((e) => e.type === "chat-message").map((e) => e.message);
  const assistantText = msgs.filter((m) => m.kind === "assistant").map((m) => m.text ?? "").join("");
  const persisted = await store.readMessages(chat.id);

  log("event types:", [...new Set(events.map((e) => e.type))].sort());
  log("statuses:", [...new Set(events.filter((e) => e.type === "chat-status").map((e) => e.status))]);
  log("assistant text:", JSON.stringify(assistantText.trim().slice(0, 100)));
  log("persisted rows:", persisted.length, "kinds:", [...new Set(persisted.map((m: any) => m.kind))]);

  const gotSentinel = /OLLEH/i.test(blob); // model-generated, NOT present in the prompt
  const persistedOk = persisted.length >= 2;
  const pass = gotSentinel && persistedOk;

  await broker.dispose();
  log("RESULT:", { gotSentinel, persistedOk, pass });
  if (pass) log("=== LIVE END-TO-END PASSED ===");
  else {
    console.error("[live] FAIL: gotSentinel=" + gotSentinel + " persistedOk=" + persistedOk);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error("[live] FAILED:", e);
  process.exitCode = 1;
});
