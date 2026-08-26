import type { HarnessGuardBlockedEvent, HarnessSessionSpec } from "./types.js";

/**
 * Evaluate the harness-neutral policy callback and describe how this runtime
 * can recover. Keeping this translation in one place prevents each adapter
 * from inventing different user-visible meanings for the same guard refusal.
 */
export function catchToolGuard(
  guard: HarnessSessionSpec["toolGuard"],
  toolName: string,
  input: Record<string, unknown>,
  continuation: HarnessGuardBlockedEvent["continuation"],
): HarnessGuardBlockedEvent | null {
  const reason = guard?.(toolName, input);
  if (!reason) return null;
  return { type: "guard-blocked", toolName, input, reason, continuation };
}

/** The hidden continuation input used after a runtime-level guard interrupt. */
export function guardRecoveryInput(events: readonly HarnessGuardBlockedEvent[]): string {
  const blocks = events.map((event, index) => {
    const target =
      typeof event.input.command === "string"
        ? `command \`${event.input.command}\``
        : `${event.toolName} call`;
    return `${events.length > 1 ? `${index + 1}. ` : ""}${target}: ${event.reason}`;
  });
  return [
    "Dispatch guard recovery: the previous turn was interrupted only to enforce host policy.",
    ...blocks,
    "Continue the task now. The blocked call may have started before the runtime could be interrupted, so inspect its target state before retrying. Use the sanctioned route named by the refusal and do not stop merely because the guard fired.",
  ].join("\n");
}
