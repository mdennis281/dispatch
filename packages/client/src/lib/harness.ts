import type { HarnessKind } from "@dispatch/shared";

export function harnessLabel(kind: HarnessKind | undefined): string {
  return kind === "codex" ? "Codex" : "Claude";
}

/**
 * The sender label for a persisted row: what wrote it, not what the chat is set
 * to now. Rows written before `row.harness` existed fall back to the chat's
 * current pick — the old behaviour, and still right for a chat that never
 * switched. Use this for anything a HISTORICAL row says about its author; read
 * `chat.harness` directly only for live/composer surfaces.
 */
export function rowHarnessLabel(
  rowHarness: HarnessKind | undefined,
  chatHarness: HarnessKind | undefined,
): string {
  return harnessLabel(rowHarness ?? chatHarness);
}

/** Persist only values accepted by the shared positive-token-limit schema. */
export function positiveTokenLimit(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}
