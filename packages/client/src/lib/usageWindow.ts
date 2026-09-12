/**
 * A usage window's name, cut down to a gauge label.
 *
 * The gauge wears the same two- or three-character label as CPU and memory, and
 * it has to name the window the PROVIDER actually has. It is parsed from the
 * snapshot's own label rather than assumed from the slot. Claude
 * always sends "5-hour session" / "Weekly", but Codex's come from
 * `windowLabel()` on the server and follow whatever window length its rate
 * limits report — calling Codex's primary window "5H" because Claude's is would
 * be a label that is right until the day it isn't. When the label says nothing
 * parseable ("Primary window"), its first three letters are still better than a
 * guess.
 */
export function windowTag(label: string | undefined, slot: "primary" | "secondary"): string {
  const text = (label ?? "").trim();
  if (/^weekly$/i.test(text)) return "WK";
  const span = /^(\d+)-(minute|hour|day)\b/i.exec(text);
  if (span) return `${span[1]}${span[2]![0]!.toUpperCase()}`;
  const word = /[a-z]+/i.exec(text)?.[0];
  if (word) return word.slice(0, 3).toUpperCase();
  return slot === "primary" ? "5H" : "WK";
}
