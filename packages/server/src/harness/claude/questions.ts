/**
 * AskUserQuestion, in both directions.
 *
 * This is the most runtime-specific corner of the Claude adapter and the reason
 * the neutral interface has a question channel at all.
 *
 * OUTBOUND. AskUserQuestion arrives on the `canUseTool` channel like a
 * permission prompt, but its `input` is a questionnaire. {@link neutralQuestions}
 * projects it onto {@link HarnessQuestion}, probing the shapes the tool
 * actually emits (a `questions[]` array, or a single flat question) because the
 * input is not schema-guaranteed.
 *
 * INBOUND. The answer is NOT returned as a payload — it is fed back by
 * REWRITING THE TOOL INPUT and allowing the call. The CLI tool then reads
 * `input.answers`, a map of QUESTION TEXT → chosen answer string, and tells the
 * model "The user did not answer the questions." for anything missing (verified
 * live against the bundled runtime). Getting that encoding wrong doesn't error;
 * it silently tells the model nobody answered, which is exactly the kind of
 * quiet failure worth isolating in one tested file.
 */
import type { HarnessQuestion, HarnessQuestionAnswer } from "../types.js";

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The `questions[]` array, or a single flat question wrapped as one. */
function questionList(input: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(input.questions)) return input.questions as Record<string, unknown>[];
  // A flat `{ question, options }` payload is one question.
  return [input];
}

function questionTextOf(
  question: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): string | undefined {
  return (
    pickStr(question?.question) ??
    pickStr(question?.prompt) ??
    pickStr(input.question) ??
    pickStr(question?.header)
  );
}

/**
 * An AskUserQuestion input → neutral questions.
 *
 * Ids are POSITIONAL (`"0"`, `"1"`, …) because Claude's questions carry no id
 * of their own and the answer must be keyed back by position.
 */
export function neutralQuestions(input: Record<string, unknown>): HarnessQuestion[] {
  return questionList(input).map((q, i) => {
    const options = Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[])
      : Array.isArray(input.options)
        ? (input.options as Record<string, unknown>[])
        : [];
    return {
      id: String(i),
      header: pickStr(q.header) ?? pickStr(q.title) ?? "Question",
      question: questionTextOf(q, input) ?? "",
      multiSelect: Boolean(q.multiSelect),
      // The tool always accepts free text; the UI offers "Other" regardless.
      allowOther: true,
      options: options.map((o) => ({
        label: String(o.label ?? o.id ?? ""),
        description: pickStr(o.description),
      })),
    };
  });
}

/**
 * Append the human's extra notes to a chosen value.
 *
 * Kept as a suffix on the value (rather than a separate field) because the tool
 * hands the model exactly this string and nothing else.
 */
function withNotes(value: string, notes?: string): string {
  const n = pickStr(notes);
  return n ? `${value} — additional instructions: ${n}` : value;
}

/**
 * Neutral answers → the rewritten AskUserQuestion input.
 *
 * Multi-select answers are comma-joined, matching what the tool expects for a
 * question that accepted several options.
 */
export function buildQuestionAnswer(
  input: Record<string, unknown>,
  answers: HarnessQuestionAnswer[],
): Record<string, unknown> {
  const questions = questionList(input);
  const out: Record<string, string> = {};
  for (const a of answers) {
    const index = Number.parseInt(a.questionId, 10);
    const q = Number.isFinite(index) ? questions[index] : undefined;
    const key = questionTextOf(q, input);
    const value = a.selected.filter((s) => pickStr(s)).join(", ");
    if (key && value) out[key] = withNotes(value, a.notes);
  }
  return { ...input, answers: out };
}

/**
 * A one-line summary of what the human picked, for the persisted row.
 *
 * Prefixed with each question's header only when there was more than one, so a
 * single answer reads as the answer rather than as a labelled field.
 */
export function answerSummary(
  input: Record<string, unknown>,
  answers: HarnessQuestionAnswer[],
): string | undefined {
  const questions = questionList(input);
  const parts: string[] = [];
  for (const a of answers) {
    const index = Number.parseInt(a.questionId, 10);
    const q = Number.isFinite(index) ? questions[index] : undefined;
    const value = withNotes(a.selected.join(", "), a.notes);
    if (!value.trim()) continue;
    const header = pickStr(q?.header);
    parts.push(header && answers.length > 1 ? `${header}: ${value}` : value);
  }
  return parts.length ? parts.join(" · ") : undefined;
}
