/**
 * Every colour rule the resource surfaces use, in one place.
 *
 * The header pill, its dropdown and the Resources page draw the same two
 * metrics at three sizes, and they each used to carry a private `tone()` with
 * its own thresholds. That is fine until they disagree — and they did: the same
 * machine could show an amber pill in the header and an accent-coloured bar on
 * the page, which reads as one of the two being wrong rather than as two
 * scales.
 *
 * ── WHY MEMORY ESCALATES AND CPU DOES NOT ────────────────────────────────────
 *
 * A pegged CPU is what a machine doing the work LOOKS like; agents compile
 * things, and a widget that turns red every build is a widget people stop
 * reading. Exhausted memory is what actually makes the box unusable, and it is
 * the one the reaper on the Resources page can do something about. So memory
 * carries the warn/danger ramp and CPU keeps one hue at every level.
 *
 * That one hue is VIOLET rather than the brand amber, which buys a second
 * thing: in the per-chat rows the memory and CPU bars are stacked one above the
 * other with no room for labels, and hue is what tells them apart.
 */

/** CPU's fill, at every level. See the note above on why it never escalates. */
export const CPU_BAR = "bg-accent-2";

/** Machine-scale memory pressure — the header pill and the page's hero card. */
export function machineTone(p: number): { text: string; bar: string } {
  if (p >= 90) return { text: "text-danger", bar: "bg-danger" };
  if (p >= 75) return { text: "text-warn", bar: "bg-warn" };
  return { text: "text-accent-hi", bar: "bg-accent" };
}

/**
 * ONE CHAT's memory as a share of the machine — a much lower scale.
 *
 * Deliberately not `machineTone`'s 75/90. A single chat holding 40% of a
 * workstation is already the answer to "which one do I reap", and one that
 * reached 75 would have taken the machine down long before the bar changed
 * colour. Thresholds are set where the reader has to act, not where the number
 * looks large.
 */
export function chatTone(p: number): string {
  if (p >= 40) return "bg-danger";
  if (p >= 15) return "bg-warn";
  return "bg-accent";
}

/**
 * The same escalation for a chat's CPU, kept in the violet family until it is
 * genuinely a fault.
 *
 * A row that escalated straight from violet to amber would collide with the
 * memory bar sitting directly above it — the one cue that tells the two bars
 * apart is exactly the hue it would be borrowing.
 */
export function chatCpuTone(p: number): string {
  if (p >= 40) return "bg-danger";
  if (p >= 15) return "bg-warn";
  return CPU_BAR;
}
