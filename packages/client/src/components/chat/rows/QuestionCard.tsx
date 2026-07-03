import { useState } from "react";
import { MessageCircleQuestion, CornerDownLeft, Check } from "lucide-react";
import type { PermissionRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
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

export interface QuestionCardProps {
  row: PermissionRow;
}

/** An AskUserQuestion card — options + free-text, answered via actions.answerQuestion. */
export function QuestionCard({ row }: QuestionCardProps) {
  const pending = row.decision === "pending";
  const questions = parseQuestions(row.input);
  const multi = questions.length > 1;

  // Per-question selection tracks option *ids* (which can differ from the display
  // label); the answer routes the id, not the label, so duplicate labels don't
  // collide. Free text is likewise per-question.
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  // Optimistic latch: disable once answered so a double-click can't fire a
  // second (server-rejected) answer.
  const [answered, setAnswered] = useState(false);
  const busy = pending && answered;

  const labelOf = (qi: number, id: string) =>
    questions[qi]?.options.find((o) => o.id === id)?.label ?? id;

  type OneAnswer = { questionIndex: number; optionId?: string; answer?: string };

  const send = (answers: OneAnswer[]) => {
    if (!pending || answered || !answers.length) return;
    setAnswered(true);
    // Single-question asks keep the original wire shape; multi-question asks send
    // an answer per question so none is dropped.
    if (answers.length === 1 && !multi) {
      const a0 = answers[0]!;
      actions.answerQuestion(row.chatId, row.requestId, {
        optionId: a0.optionId,
        answer: a0.answer,
      });
    } else {
      actions.answerQuestion(row.chatId, row.requestId, { answers });
    }
  };

  const toggle = (qi: number, id: string, single: boolean) =>
    setSelected((s) => {
      const cur = s[qi] ?? [];
      if (single) return { ...s, [qi]: [id] };
      return { ...s, [qi]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  /** The chosen answer for one question (free text wins over selected options). */
  const valueFor = (qi: number): { optionId?: string; answer?: string } | null => {
    const ft = (freeText[qi] ?? "").trim();
    if (ft) return { answer: ft };
    const sel = selected[qi] ?? [];
    if (sel.length) return { answer: sel.map((id) => labelOf(qi, id)).join(", "), optionId: sel[0] };
    return null;
  };

  const allAnswered = questions.every((_, qi) => valueFor(qi) !== null);

  // Submit every question at once (the multi-question path). Gated by disabling
  // until all are answered — never allow-then-error.
  const submitAll = () => {
    const answers: OneAnswer[] = questions.map((_, qi) => {
      const v = valueFor(qi)!;
      return { questionIndex: qi, optionId: v.optionId, answer: v.answer };
    });
    send(answers);
  };

  // Immediate-submit helpers for the single-question case (preserved UX).
  const answerSingleOption = (o: QuestionOption) =>
    send([{ questionIndex: 0, optionId: o.id, answer: o.label }]);
  const submitSingleMulti = () => {
    const sel = selected[0] ?? [];
    if (!sel.length) return;
    send([{ questionIndex: 0, optionId: sel[0], answer: sel.map((id) => labelOf(0, id)).join(", ") }]);
  };
  const submitSingleFree = () => {
    const t = (freeText[0] ?? "").trim();
    if (t) send([{ questionIndex: 0, answer: t }]);
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
          {pending ? (
            <Chip tone={busy ? "muted" : "accent"} className="ml-auto">
              {busy ? "sending…" : "needs answer"}
            </Chip>
          ) : (
            <Chip tone="success" className="ml-auto">
              answered
            </Chip>
          )}
        </div>

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

        {/* Multi-question asks submit every answer together. */}
        {pending && multi && (
          <div className="flex items-center gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<CornerDownLeft />}
              disabled={!allAnswered || busy}
              onClick={submitAll}
            >
              Submit answers
            </Button>
            {!allAnswered && (
              <span className="text-[11px] text-muted">
                Answer all {questions.length} to continue
              </span>
            )}
          </div>
        )}

        {!pending && row.message && (
          <div className="border-t border-line-soft px-3 py-2">
            <p className="text-[11.5px] text-muted">You answered: {row.message}</p>
          </div>
        )}
      </div>
    </RowShell>
  );
}
