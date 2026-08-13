import type { HarnessKind } from "@dispatch/shared";

export function harnessLabel(kind: HarnessKind | undefined): string {
  return kind === "codex" ? "Codex" : "Claude";
}

/** Persist only values accepted by the shared positive-token-limit schema. */
export function positiveTokenLimit(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}
