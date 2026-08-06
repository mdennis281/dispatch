import { useState } from "react";
import { MessageCircleQuestion, CornerDownLeft, Check, Undo2 } from "lucide-react";
import type { PermissionRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import { useChats } from "../../../stores/chats.js";
import { attentionCardId } from "../../attention/focus.js";

interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}
interface ParsedQuestion {
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function parseOptions(
  first: Record<string, unknown>,
  input: Record<string, unknown>,
): QuestionOption[] {
  const rawOptions = Array.isArray(first.options)
    ? first.options
    : Array.isArray(input.options)
      ? input.options
      : [];
  return rawOptions.map((o, i) => {
    if (typeof o === "string") return { id: o, label: o };
    const obj = (o ?? {}) as Record<string, unknown>;
    const label =
      str(obj.label) ?? str(obj.optionText) ?? str(obj.text) ?? str(obj.value) ?? `Option ${i + 1}`;
    return {
      id: str(obj.id) ?? label,
      label,
      description: str(obj.description) ?? str(obj.detail),
    };
  });
}

function parseOne(first: Record<string, unknown>, input: Record<string, unknown>): ParsedQuestion {
  return {
    header: str(first.header) ?? str(first.title),
    question:
      str(first.question) ?? str(first.prompt) ?? str(first.text) ?? "Claude has a question.",
    options: parseOptions(first, input),
    multiSelect: first.multiSelect === true || first.multiselect === true,
  };
}

/**
 * AskUserQuestion rides the permission channel, so its payload shape isn't
 * guaranteed — parse defensively. Handles `{ questions: [{…}, …] }` (one or many
 * question groups) and a flat `{ question, header, options }`, with options as
 * strings or objects. ALL questions are returned; a multi-question ask must be
 * answered in full or the model treats the missing ones as unanswered.
 */
function parseQuestions(input: Record<string, unknown>): ParsedQuestion[] {
  const list =
    Array.isArray(input.questions) && input.questions.length
      ? (input.questions as unknown[])
      : [input];
  return list.map((q) => parseOne((q ?? {}) as Record<string, unknown>, input));
}

/**
 * Compose the correction sent when re-answering an already-resolved question.
 *
 * A resolved question can't be re-opened: its `canUseTool` promise settled the
 * moment it was answered and the model has already acted on it. So the revert
 * interrupts the turn and states the correction as a normal user message —
 * which is what you'd otherwise type by hand.
 */
function buildCorrection(
  questions: ParsedQuestion[],
  answers: OneAnswer[],
  previous: string | undefined,
  wasDeclined: boolean,
): string {
  const out = ["I picked the wrong answer to your question and stopped you. Correcting it:", ""];
  for (const [qi, q] of questions.entries()) {
    const a = answers.find((x) => x.questionIndex === qi);
    if (!a) continue;
    if (questions.length > 1) out.push(`Question: ${q.question}`);
    out.push(`Corrected answer: ${a.answer ?? a.optionId ?? ""}`);
    if (a.notes) out.push(`Additional instructions: ${a.notes}`);
    out.push("");
  }
  out.push(
    wasDeclined
      ? "(I previously declined to answer.)"
      : `(My previous answer was: ${previous ?? "unknown"}.)`,
    "",
    "Disregard the previous answer and continue from the corrected one.",
  );
  return out.join("\n");
}

type OneAnswer = {
  questionIndex: number;
  optionId?: string;
  answer?: string;
  notes?: string;
};

export interface QuestionCardProps {
  row: PermissionRow;
}

/** An AskUserQuestion card — options + notes + free-text, answered via actions.answerQuestion. */
export function QuestionCard({ row }: QuestionCardProps) {
  const resolvedPending = row.decision === "pending";
  const declined = row.decision === "deny";
  const questions = parseQuestions(row.input);
  const multi = questions.length > 1;

  const chatStatus = useChats((s) => s.byId[row.chatId]?.status);

  // Re-answering a resolved question: the card goes interactive again, but the
  // answer leaves as a message rather than a (long-gone) permission result.
  const [reverting, setReverting] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [corrected, setCorrected] = useState(false);
  const pending = resolvedPending || reverting;

  // Per-question selection tracks option *ids* (which can differ from the display
  // label); the answer routes the id, not the label, so duplicate labels don't
  // collide. Free text is likewise per-question.
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  // Extra instructions carried WITH the chosen option (as opposed to freeText,
  // which replaces it).
  const [notes, setNotes] = useState<Record<number, string>>({});
  // Optimistic latch: disable once answered so a double-click can't fire a
  // second (server-rejected) answer.
  const [answered, setAnswered] = useState(false);
  const busy = pending && answered;

  const labelOf = (qi: number, id: string) =>
    questions[qi]?.options.find((o) => o.id === id)?.label ?? id;

  const send = (answers: OneAnswer[]) => {
    if (!pending || answered || !answers.length) return;

    if (reverting) {
      // The original request is long resolved — deliver the correction as a
      // message. Mirror the composer's rule: steer a turn that's somehow still
      // running (the interrupt may not have landed yet), otherwise send.
      // No `answered` latch here: clearing `reverting` closes the card in the
      // same batch, so `pending` goes false and re-entry is already blocked.
      const text = buildCorrection(questions, answers, row.message, declined);
      if (chatStatus === "running") actions.steer(row.chatId, text, "next");
      else actions.sendMessage(row.chatId, { text });
      setReverting(false);
      setCorrected(true);
      return;
    }

    setAnswered(true);
    // Single-question asks keep the original wire shape; multi-question asks send
    // an answer per question so none is dropped.
    if (answers.length === 1 && !multi) {
      const a0 = answers[0]!;
      actions.answerQuestion(row.chatId, row.requestId, {
        optionId: a0.optionId,
        answer: a0.answer,
        notes: a0.notes,
      });
    } else {
      actions.answerQuestion(row.chatId, row.requestId, { answers });
    }
  };

  /**
   * Stop whatever the wrong answer set in motion, then re-open this card. Two
   * clicks, because it interrupts a live turn — the same confirm idiom the
   * destructive git actions use.
   */
  const revert = () => {
    if (!confirmRevert) {
      setConfirmRevert(true);
      return;
    }
    setConfirmRevert(false);
    if (chatStatus === "running" || chatStatus === "awaiting-input") {
      actions.interrupt(row.chatId);
    }
    setSelected({});
    setFreeText({});
    setNotes({});
    setAnswered(false);
    setCorrected(false);
    setReverting(true);
  };

  /**
   * Decline without answering — the model sees the question as declined. Only
   * valid for a LIVE request; a re-answer has no permission left to decline
   * (the card offers Cancel there instead).
   */
  const decline = () => {
    if (!resolvedPending || answered) return;
    setAnswered(true);
    actions.declineQuestion(row.chatId, row.requestId);
  };

  const toggle = (qi: number, id: string, single: boolean) =>
    setSelected((s) => {
      const cur = s[qi] ?? [];
      if (single) return { ...s, [qi]: [id] };
      return { ...s, [qi]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  const noteFor = (qi: number) => (notes[qi] ?? "").trim() || undefined;

  /**
   * The chosen answer for one question. Free text wins over selected options
   * (it's an alternative answer); notes ride along with either, since they
   * qualify the choice rather than replace it.
   */
  const valueFor = (qi: number): OneAnswer | null => {
    const nt = noteFor(qi);
    const ft = (freeText[qi] ?? "").trim();
    if (ft) return { questionIndex: qi, answer: ft, notes: nt };
    const sel = selected[qi] ?? [];
    if (sel.length) {
      return {
        questionIndex: qi,
        answer: sel.map((id) => labelOf(qi, id)).join(", "),
        optionId: sel[0],
        notes: nt,
      };
    }
    return null;
  };

  const allAnswered = questions.every((_, qi) => valueFor(qi) !== null);

  // Submit every question at once (the multi-question path). Gated by disabling
  // until all are answered — never allow-then-error.
  const submitAll = () => send(questions.map((_, qi) => valueFor(qi)!));

  // Immediate-submit helpers for the single-question case (preserved UX).
  const answerSingleOption = (o: QuestionOption) =>
    send([{ questionIndex: 0, optionId: o.id, answer: o.label, notes: noteFor(0) }]);
  const submitSingleMulti = () => {
    const sel = selected[0] ?? [];
    if (!sel.length) return;
    send([
      {
        questionIndex: 0,
        optionId: sel[0],
        answer: sel.map((id) => labelOf(0, id)).join(", "),
        notes: noteFor(0),
      },
    ]);
  };
  const submitSingleFree = () => {
    const t = (freeText[0] ?? "").trim();
    if (t) send([{ questionIndex: 0, answer: t, notes: noteFor(0) }]);
  };

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            pending
              ? "bg-accent-ghost text-accent-hi ring-accent-line"
              : "bg-panel-2 text-muted ring-line",
          )}
        >
          <MessageCircleQuestion />
        </span>
      }
    >
      <div
        id={attentionCardId(row.requestId)}
        className={cn(
          "overflow-hidden rounded-md border",
          pending ? "border-accent-line bg-accent-ghost/20 cm-raise" : "border-line bg-panel-2/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-[12.5px] text-primary">
            {multi ? (
              <>
                Claude has some <span className="font-semibold text-accent-hi">questions</span>
              </>
            ) : questions[0]?.header ? (
              <>
                Claude asks — <span className="font-semibold text-accent-hi">{questions[0].header}</span>
              </>
            ) : (
              <>
                Claude has a <span className="font-semibold text-accent-hi">question</span>
              </>
            )}
          </span>
          {reverting ? (
            <Chip tone="accent" className="ml-auto">
              {busy ? "sending…" : "re-answering"}
            </Chip>
          ) : resolvedPending ? (
            <Chip tone={busy ? "muted" : "accent"} className="ml-auto">
              {busy ? "sending…" : "needs answer"}
            </Chip>
          ) : (
            <Chip tone={corrected ? "accent" : declined ? "muted" : "success"} className="ml-auto">
              {corrected ? "corrected" : declined ? "declined" : "answered"}
            </Chip>
          )}
        </div>

        {reverting && (
          <div className="border-t border-line-soft bg-accent-ghost/30 px-3 py-2">
            <p className="text-[11.5px] text-secondary">
              Agent stopped. {declined ? "You declined this." : `Previously: ${row.message ?? "—"}.`}{" "}
              Pick again — your answer is sent as a correction.
            </p>
          </div>
        )}

        {questions.map((q, qi) => {
          const sel = selected[qi] ?? [];
          return (
            <div key={qi}>
              <div className="border-t border-line-soft px-3 py-2">
                {multi && q.header && (
                  <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-accent-hi">
                    {q.header}
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-secondary">
                  {q.question}
                </p>
              </div>

              {pending && (
                <div className="flex flex-col gap-1.5 border-t border-line-soft bg-inset/60 px-3 py-2.5">
                  {/* Above the options on purpose: a single-question ask submits
                      the moment an option is clicked, so the notes have to be
                      typeable before that click. */}
                  <input
                    value={notes[qi] ?? ""}
                    onChange={(e) => setNotes((s) => ({ ...s, [qi]: e.target.value }))}
                    disabled={busy}
                    placeholder="Notes (optional) — sent along with whichever option you pick"
                    className={cn(
                      "h-7 min-w-0 rounded-md border border-line bg-panel-2 px-2 text-[12px] text-primary",
                      "placeholder:text-faint focus:border-line-strong focus:outline-none",
                    )}
                  />

                  {q.options.map((o) => {
                    const isSel = sel.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        disabled={busy}
                        onClick={() => {
                          if (q.multiSelect) toggle(qi, o.id, false);
                          else if (multi) toggle(qi, o.id, true);
                          else answerSingleOption(o);
                        }}
                        className={cn(
                          "group flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                          isSel
                            ? "border-accent-line bg-accent-ghost text-primary"
                            : "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary",
                        )}
                      >
                        {(q.multiSelect || multi) && (
                          <span
                            className={cn(
                              "mt-px flex size-4 shrink-0 items-center justify-center border [&_svg]:size-3",
                              q.multiSelect ? "rounded-[4px]" : "rounded-full",
                              isSel
                                ? "border-accent-line bg-accent-dim text-white"
                                : "border-line-strong text-transparent",
                            )}
                          >
                            <Check />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-medium">{o.label}</span>
                          {o.description && (
                            <span className="mt-0.5 block text-[11px] text-muted">{o.description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}

                  {/* Single-question multi-select submits on its own button. */}
                  {!multi && q.multiSelect && q.options.length > 0 && (
                    <Button
                      variant="primary"
                      size="sm"
                      className="self-start"
                      disabled={sel.length === 0 || busy}
                      onClick={submitSingleMulti}
                    >
                      Submit{sel.length ? ` (${sel.length})` : ""}
                    </Button>
                  )}

                  <div className="mt-0.5 flex items-center gap-1.5">
                    <input
                      value={freeText[qi] ?? ""}
                      onChange={(e) => setFreeText((s) => ({ ...s, [qi]: e.target.value }))}
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !multi) {
                          e.preventDefault();
                          submitSingleFree();
                        }
                      }}
                      placeholder={q.options.length ? "…or type a custom answer" : "Type your answer"}
                      className={cn(
                        "h-7 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 text-[12px] text-primary",
                        "placeholder:text-faint focus:border-line-strong focus:outline-none",
                      )}
                    />
                    {/* Single-question free-text has its own inline send. */}
                    {!multi && (
                      <Button
                        variant="default"
                        size="sm"
                        leftIcon={<CornerDownLeft />}
                        disabled={!(freeText[qi] ?? "").trim() || busy}
                        onClick={submitSingleFree}
                      >
                        Send
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Pending footer: multi-question submit (when applicable) + a decline
            escape hatch. Declining resolves the question without answering. */}
        {pending && (
          <div className="flex items-center gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            {/* While re-answering, EVERY shape needs an explicit submit: the
                immediate-on-click path belongs to the live permission channel,
                and a correction goes out as a message instead. */}
            {(multi || reverting) && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<CornerDownLeft />}
                  disabled={!allAnswered || busy}
                  onClick={submitAll}
                >
                  {reverting ? "Send correction" : "Submit answers"}
                </Button>
                {!allAnswered && (
                  <span className="text-[11px] text-muted">
                    {multi ? `Answer all ${questions.length} to continue` : "Pick an answer"}
                  </span>
                )}
              </>
            )}
            {reverting ? (
              <button
                disabled={busy}
                onClick={() => setReverting(false)}
                className="ml-auto text-[11px] text-muted transition-colors hover:text-primary disabled:opacity-50"
              >
                Cancel
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={decline}
                className="ml-auto text-[11px] text-muted transition-colors hover:text-primary disabled:opacity-50"
              >
                Decline
              </button>
            )}
          </div>
        )}

        {!pending && (declined || row.message || corrected) && (
          <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
            <p className="min-w-0 flex-1 text-[11.5px] text-muted">
              {corrected
                ? "Correction sent — the agent was stopped and told your real answer."
                : declined
                  ? "You declined this question."
                  : `You answered: ${row.message}`}
            </p>
            {/* Escape hatch for the misclick: stop the work the wrong answer
                started and ask again. */}
            <button
              onClick={revert}
              onBlur={() => setConfirmRevert(false)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors [&_svg]:size-3",
                confirmRevert
                  ? "bg-accent-ghost text-accent-hi"
                  : "text-muted hover:text-primary",
              )}
              title="Stop the agent and answer this question again"
            >
              <Undo2 />
              {confirmRevert ? "Stop & re-answer?" : "Change answer"}
            </button>
          </div>
        )}
      </div>
    </RowShell>
  );
}
