/**
 * Spike — prove the LIVE model list works over subscription auth (no API key).
 *
 * Background: the picker used to read `GET /v1/models`, which requires an
 * ANTHROPIC_API_KEY. This app runs on subscription/OAuth credentials, so that
 * call never fired and the picker always served the static fallback — it looked
 * hardcoded because it effectively was.
 *
 * `Query.supportedModels()` asks the Claude Code runtime instead, so it reflects
 * exactly what this user's auth can select (incl. `default` and `[1m]` aliases)
 * with no key. This exercises the real `services/models.ts` path, then re-runs
 * it to confirm the cache holds.
 *
 * Run: pnpm --filter @dispatch/server exec tsx spikes/supported-models.ts
 */
import { listAvailableModels } from "../src/services/models.js";

const log = (...a: unknown[]) => console.log("[models-spike]", ...a);

async function main() {
  const t0 = Date.now();
  const models = await listAvailableModels();
  const probeMs = Date.now() - t0;

  log(`got ${models.length} models in ${probeMs}ms`);
  console.log(JSON.stringify(models, null, 2));

  const t1 = Date.now();
  await listAvailableModels();
  log(`cached re-read in ${Date.now() - t1}ms`);

  // A live read is the whole point; the static fallback answers instantly, so a
  // sub-100ms first read means we silently degraded rather than probed.
  if (probeMs < 100) {
    console.error("[models-spike] FAIL: served the static fallback, not the live runtime list");
    process.exitCode = 1;
  } else {
    log("=== LIVE MODEL LIST OVER SUBSCRIPTION AUTH PROVEN ===");
  }
}

void main().catch((e) => {
  console.error("[models-spike] FAILED:", e);
  process.exitCode = 1;
});
