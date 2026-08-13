import type { HarnessKind } from "@dispatch/shared";

export function harnessLabel(kind: HarnessKind | undefined): string {
  return kind === "codex" ? "Codex" : "Claude";
}
