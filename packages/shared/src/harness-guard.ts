import type {
  HarnessGuardBlockedEvent,
  HarnessSessionSpec,
  HarnessToolGuard,
  HarnessToolGuardContext,
} from "./harness.js";

/**
 * Evaluate the harness-neutral policy callback and describe how this runtime
 * can recover. Keeping this translation in one place prevents each adapter
 * from inventing different user-visible meanings for the same guard refusal.
 */
export async function catchToolGuard(
  guard: HarnessSessionSpec["toolGuard"],
  toolName: string,
  input: Record<string, unknown>,
  continuation: HarnessGuardBlockedEvent["continuation"],
  ctx: HarnessToolGuardContext = {},
): Promise<HarnessGuardBlockedEvent | null> {
  const reason = await guard?.(toolName, input, ctx);
  if (!reason) return null;
  return { type: "guard-blocked", toolName, input, reason, continuation };
}

/**
 * Fold several guards into the ONE {@link HarnessToolGuard} a session gets.
 *
 * Run IN ORDER, and the first refusal wins — the rest are not consulted. That
 * is a behaviour, not an optimisation. As separate Claude `PreToolUse` hooks
 * the guards all ran on every call, so a command another guard refused could
 * still spend a one-shot workflow exemption: the human's grant was burned on a
 * call that never ran. Ordered, a guard placed last (the one that consumes
 * grants) only ever sees calls everything else already let through.
 *
 * A guard that THROWS is skipped, not obeyed. Each guard is responsible for
 * its own failure policy (the cwd guard already answers "allow" on a `stat`
 * error); this only stops one guard's bug from taking the whole tool surface
 * down with it, which is what an unhandled rejection in an adapter would do.
 */
export function composeToolGuards(
  guards: readonly HarnessToolGuard[],
  onError?: (err: unknown) => void,
): HarnessToolGuard {
  return async (toolName, input, ctx) => {
    for (const guard of guards) {
      let reason: string | null;
      try {
        reason = await guard(toolName, input, ctx);
      } catch (err) {
        onError?.(err);
        continue;
      }
      if (reason) return reason;
    }
    return null;
  };
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
