/**
 * Dispatch's session vocabulary → Codex's thread/turn parameters.
 *
 * The interesting translation is permission posture. Dispatch (following Claude
 * Code) expresses it as ONE mode that covers both "what will you ask me about"
 * and "what may you touch". Codex splits that into two orthogonal axes:
 *
 *   approvalPolicy  untrusted | on-request | granular | never
 *   sandbox         read-only | workspace-write | danger-full-access
 *
 * So every Dispatch mode maps to a PAIR, and a couple of Claude modes have no
 * exact Codex twin. Those are documented at the mapping rather than silently
 * approximated, because the difference is a safety property:
 *
 *   acceptEdits  Claude auto-approves edits but still asks about commands.
 *                Codex cannot split approval by tool kind, so this lands on
 *                on-request/workspace-write — edits inside the workspace go
 *                through without a prompt because the sandbox already permits
 *                them, and commands still prompt. Behaviourally very close.
 *   plan         Claude refuses to mutate anything. Codex gets read-only, which
 *                enforces it harder than Claude does (the sandbox blocks writes
 *                rather than the model declining to make them).
 */
import type { Effort, PermissionMode } from "@dispatch/shared";

/** Codex's two-axis posture. */
export interface CodexPosture {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

/** Dispatch permission mode → Codex approval policy + sandbox. */
export function toCodexPosture(mode: PermissionMode): CodexPosture {
  switch (mode) {
    case "plan":
      // Hard read-only: the sandbox enforces what Claude only asks for.
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "acceptEdits":
      // Workspace writes pass without a prompt; commands still ask.
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "dontAsk":
      // Don't prompt, but stay inside the workspace.
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "default":
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

/**
 * Dispatch effort → Codex reasoning effort.
 *
 * The two ladders agree on low/medium/high/xhigh. Codex adds "ultra" above
 * "max" on some models; Dispatch's shared `Effort` enum has no member for it,
 * so "max" is as high as a Dispatch chat can ask for. Passing an effort a model
 * doesn't support makes `turn/start` fail, so the caller clamps against the
 * model's advertised list (see CodexHarness.listModels).
 */
export function toCodexEffort(effort: Effort): string {
  return effort;
}

/**
 * Clamp an effort to what a model actually supports.
 *
 * Codex's `model/list` reports per-model effort options and rejects anything
 * else at turn start. Falling back to the highest supported level below the
 * request keeps "I asked for max" meaning "give me as much as you have".
 */
export function clampEffort(effort: Effort, supported: string[]): string | undefined {
  if (!supported.length) return effort;
  if (supported.includes(effort)) return effort;
  const ladder = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const want = ladder.indexOf(effort);
  for (let i = want; i >= 0; i--) {
    const candidate = ladder[i]!;
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0];
}

/**
 * Dispatch's system-prompt appends → Codex's instruction slots.
 *
 * Codex exposes two: `baseInstructions` REPLACES its stock prompt entirely, and
 * `developerInstructions` is layered on top of it. We only ever use the latter —
 * replacing the base prompt would throw away Codex's own tool guidance and
 * safety framing, which is precisely the runtime behaviour a user chose Codex
 * to get. This is the direct analogue of the Claude adapter's
 * `systemPrompt: { type: "preset", preset: "claude_code", append }`.
 */
export function toDeveloperInstructions(appends: string[]): string | undefined {
  const joined = appends.filter((a) => a && a.trim()).join("\n\n");
  return joined || undefined;
}
