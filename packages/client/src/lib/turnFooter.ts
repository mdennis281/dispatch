import type { ResultRow } from "@dispatch/shared";
import { dur } from "./format.js";

/** "$2.14", "$0.004" — a cost too small for cents keeps three places. */
function money(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export interface TurnFooter {
  /** The middot-joined figures shown on the row. */
  parts: string[];
  /** The hover note, or null when there is nothing to add. */
  note: string | null;
}

/**
 * What the end-of-turn marker is allowed to claim.
 *
 * Every figure on this row is read as a fact about the turn that just ended, so
 * two of the three the provider hands over need translating first:
 *
 *   - `numTurns` counts the agent's own loop steps — one per model response,
 *     tool calls included. Printed as "turns" next to the words "Turn complete"
 *     it produced "Turn complete · 409 turns", which is not a sentence anyone
 *     can parse.
 *   - `costUsd` is SESSION-cumulative. Beside the per-turn step count and
 *     duration it read as the price of the turn you just watched — off by the
 *     whole chat. It belongs in the note; `turnCostUsd` is the row's figure.
 */
export function turnFooter(row: ResultRow): TurnFooter {
  const parts: string[] = [];
  if (row.numTurns) parts.push(`${row.numTurns} step${row.numTurns === 1 ? "" : "s"}`);
  const d = dur(row.durationMs);
  if (d) parts.push(d);

  const turn = row.turnCostUsd;
  const total = row.costUsd;
  const haveTotal = typeof total === "number" && total > 0;
  // ABSENT, not merely zero: a free turn is a known $0, and labelling that row's
  // running total "total" would both misreport it as legacy and contradict the
  // note beside it. Only a row recorded before per-turn cost existed gets that.
  const legacy = turn === undefined;
  if (!legacy) {
    if (turn > 0) parts.push(money(turn));
  } else if (haveTotal) {
    parts.push(`${money(total)} total`);
  }

  const note = legacy
    ? haveTotal
      ? `${money(total)} for the chat so far, at API rates — this turn's share wasn't recorded`
      : null
    : haveTotal
      ? `This turn cost ${money(turn)} · ${money(total)} for the chat so far, at API rates`
      : `This turn cost ${money(turn)}`;
  return { parts, note };
}
