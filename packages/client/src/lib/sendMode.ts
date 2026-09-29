/**
 * What Send does to a turn that is ALREADY RUNNING, and which chord picks it.
 *
 * Three behaviours, and the whole point of splitting them is that mid-turn they
 * are genuinely different intentions — not three routes to the same place:
 *
 *   - `steer`     "also do this" — the agent sees it mid-thought, this turn.
 *   - `queue`     "when you're done" — held back so it doesn't derail the turn.
 *   - `interrupt` "stop, do this instead" — the turn is cut off first.
 *
 * NONE of it applies to an idle chat. There is nothing to steer, hold behind or
 * cut off, so every chord just sends — which is why {@link sendModeFromKey}
 * takes `running` and returns the plain default when it is false.
 *
 * The server owns the behaviour (`SendMode` in shared, `pendingSends` in the
 * broker). This file owns only the presentation: labels, the key hints, and the
 * event → mode mapping the composer's `handleKeyDown` asks for.
 */
import { DEFAULT_SEND_MODE, type SendMode } from "@dispatch/shared";
import { isApple } from "./submitHint.js";

export { DEFAULT_SEND_MODE, type SendMode };

/** Menu order: gentlest first, most destructive last — nobody mis-clicks up. */
export const SEND_MODES: readonly SendMode[] = ["steer", "queue", "interrupt"];

/** Button/menu label. Verbs, because each row DOES the thing when clicked. */
export const SEND_MODE_LABEL: Record<SendMode, string> = {
  steer: "Steer",
  queue: "Queue",
  interrupt: "Interrupt",
};

/** One line of menu detail: what it does to the turn in flight. */
export const SEND_MODE_BLURB: Record<SendMode, string> = {
  steer: "Inject into the running turn — the agent reads it mid-thought.",
  queue: "Hold it back, then send when this turn finishes.",
  interrupt: "Stop the turn now and send this instead.",
};

/**
 * The chord, spelled for THIS machine.
 *
 * `⌘` on a Mac and `Ctrl` everywhere else, and only ever one of them: naming
 * the other platform's modifier is noise at best and wrong at worst (the same
 * reasoning, and the same `isApple`, as the composer placeholder).
 *
 * `steer` is the bare default chord rather than a third modifier, because it IS
 * what the button does — see {@link sendModeFromKey}.
 */
export function sendModeKeyHint(mode: SendMode, apple = isApple()): string {
  const mod = apple ? "⌘" : "Ctrl";
  if (mode === "queue") return "⇧↵";
  if (mode === "interrupt") return `${mod}⇧↵`;
  return `${mod}↵`;
}

/** Just the modifiers pressed, so the table below reads as a table. */
function chord(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): string {
  return `${event.metaKey || event.ctrlKey ? "mod" : ""}${event.shiftKey ? "+shift" : ""}`;
}

/**
 * Which mode a keydown asks for, or `null` for "not a send — leave the event
 * alone".
 *
 * `mod↵` deliberately resolves to the app DEFAULT rather than hard-coding
 * `steer`: it is the same action as clicking the button, and a user who set the
 * default to Queue would otherwise find the main chord and the main button
 * disagreeing. The two explicit chords always mean exactly what they say.
 *
 * Bare `⇧↵` only claims the event while a turn is running. Idle, it is the
 * newline the editor has always inserted — a binding that stole it outright
 * would cost every multi-line message to buy a mid-turn shortcut.
 */
export function sendModeFromKey(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  { running, appDefault }: { running: boolean; appDefault: SendMode },
): SendMode | null {
  if (event.key !== "Enter") return null;
  switch (chord(event)) {
    case "mod":
      return running ? appDefault : DEFAULT_SEND_MODE;
    // Idle it still SENDS rather than doing nothing. `mod↵` with a stray shift
    // held has always sent, and a chord that silently stopped working the moment
    // the agent went idle would read as the composer being broken.
    case "mod+shift":
      return running ? "interrupt" : DEFAULT_SEND_MODE;
    case "+shift":
      return running ? "queue" : null;
    default:
      return null;
  }
}
