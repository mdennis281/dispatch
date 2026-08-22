import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, CornerDownLeft, Check, Undo2 } from "lucide-react";
import { composeMessageText, type MessagePart, type PermissionRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { cn } from "../../../lib/cn.js";
import { actions } from "../../../lib/actions.js";
import { useChats } from "../../../stores/chats.js";
import { attentionCardId } from "../../attention/focus.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

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
      str(first.question) ?? str(first.prompt) ?? str(first.text) ?? "The agent has a question.",
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
 * interrupts the turn and delivers the correction as a message instead.
 *
 * Written ABOUT the human rather than AS them, because it ships as a `brief` —
 * Dispatch's words, not theirs. The card header says so in the transcript, but
 * the model only ever sees this text, so the voice has to carry it: a first
 * person "I" here would read as Dispatch claiming to have answered its own
 * question.
 *
 * Laid out as MARKDOWN for the same reason: a brief is rendered through
 * `Markdown`, not `whitespace-pre-wrap`. Written with bare newlines the answer
 * and the notes collapsed onto one run-on line — "Revised answer: X Additional
 * instructions: Y" — so each field is its own list item and every block is
 * blank-line separated.
 */
function buildCorrection(
  questions: ParsedQuestion[],
  answers: OneAnswer[],
  previous: string | undefined,
  wasDeclined: boolean,
): string {
  const out = ["The human picked the wrong answer to your question and stopped you to fix it:", ""];
  for (const [qi, q] of questions.entries()) {
    const a = answers.find((x) => x.questionIndex === qi);
    if (!a) continue;
    // The question paragraph also keeps each question's bullets a separate
    // list; back-to-back bullet groups would otherwise merge into one.
    if (questions.length > 1) out.push(`**Question:** ${q.question}`, "");
    out.push(`- **Revised answer:** ${a.answer ?? a.optionId ?? ""}`);
    if (a.notes) out.push(`- **Additional instructions:** ${a.notes}`);
    out.push("");
  }
  out.push(
    wasDeclined
      ? "(They previously declined to answer.)"
      : `(Their previous answer was: ${previous ?? "unknown"}.)`,
    "",
    "Disregard the previous answer and continue from the revised one.",
  );
  return out.join("\n");
}

/**
 * The radio/checkbox dot. Shared so the custom-answer row is visibly the same
 * KIND of thing as the listed options — if it drew its own marker they'd drift.
 */
function Marker({ checked, multi }: { checked: boolean; multi: boolean }) {
  return (
    <span
      data-marker=""
      className={cn(
        "mt-px flex size-4 shrink-0 items-center justify-center border [&_svg]:size-3",
        multi ? "rounded-[4px]" : "rounded-full",
        checked ? "border-accent-line bg-accent text-accent-fg" : "border-line-strong text-transparent",
      )}
    >
      <Check />
    </span>
  );
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

/**
 * An AskUserQuestion card — options + notes + free-text, answered via
 * actions.answerQuestion.
 *
 * ONE interaction grammar for every shape of ask (single/multi question,
 * single/multi select, live/re-answer): clicking an option only SELECTS it, and
 * a single Submit in the footer sends the lot.
 *
 * The card used to fire the answer on the click itself for the commonest shape
 * (one question, one choice). That forced the notes field to sit ABOVE the
 * options — you had to be able to type it before the click that ended the
 * interaction — which put an optional field in front of the thing everyone came
 * to do, and meant the same card taught two different grammars depending on a
 * `multiSelect` flag the reader can't see. Selecting first costs one click and
 * buys a card you can read top-to-bottom: question, choices, then the optional
 * qualifiers, then send.
 */
export function QuestionCard({ row }: QuestionCardProps) {
  const resolvedPending = row.decision === "pending";
  const declined = row.decision === "deny";
  const questions = parseQuestions(row.input);
  const multi = questions.length > 1;

  const chatStatus = useChats((s) => s.byId[row.chatId]?.status);
  const provider = rowHarnessLabel(row.harness, useChats((s) => s.byId[row.chatId]?.harness));

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
  // The custom answer is a CHOICE, not a side channel: it has its own radio in
  // the option list and this is its selected state. Text alone no longer wins —
  // typing while an option was checked used to silently override it, which read
  // as the click being ignored.
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const customRefs = useRef<Record<number, HTMLInputElement | null>>({});
  // Extra instructions carried WITH the chosen option (as opposed to freeText,
  // which replaces it).
  const [notes, setNotes] = useState<Record<number, string>>({});
  // Optimistic latch: disable once answered so a double-click can't fire a
  // second (server-rejected) answer.
  const [answered, setAnswered] = useState(false);
  const busy = pending && answered;

  const timeoutSeconds =
    typeof row.input.timeoutSeconds === "number" ? row.input.timeoutSeconds : undefined;
  const activity = useRef<{ lastSent: number; timer?: ReturnType<typeof setTimeout> }>({
    lastSent: 0,
  });

  useEffect(
    () => () => {
      if (activity.current.timer) clearTimeout(activity.current.timer);
    },
    [],
  );

  const touch = () => {
    if (!resolvedPending || !timeoutSeconds) return;
    // Send immediately when the interval has elapsed, then one trailing refresh
    // for activity inside it. Half the configured timeout keeps even the 1s
    // minimum alive while capping continuous typing at two frames per second.
    const intervalMs = Math.max(100, Math.min(1_000, (timeoutSeconds * 1_000) / 2));
    const elapsed = Date.now() - activity.current.lastSent;
    const sendActivity = () => {
      actions.questionActivity(row.chatId, row.requestId);
      activity.current.lastSent = Date.now();
      activity.current.timer = undefined;
    };
    if (activity.current.lastSent === 0 || elapsed >= intervalMs) {
      if (activity.current.timer) clearTimeout(activity.current.timer);
      sendActivity();
    } else if (!activity.current.timer) {
      activity.current.timer = setTimeout(sendActivity, intervalMs - elapsed);
    }
  };

  const labelOf = (qi: number, id: string) =>
    questions[qi]?.options.find((o) => o.id === id)?.label ?? id;

  const send = (answers: OneAnswer[]) => {
    if (!pending || answered || !answers.length) return;

    if (reverting) {
      // The original request is long resolved — deliver the correction as a
      // composed brief. `send-message` also steers an active turn, so the parts
      // survive if the interrupt has not landed yet.
      //
      // `brief`, not `instructions`: the human chose an option, but every word
      // of this message is Dispatch's — so it gets the "Dispatch → Claude" card
      // the launched tasks use, rather than the speech bubble that presented an
      // app-composed paragraph as something they typed.
      //
      // No `answered` latch here: clearing `reverting` closes the card in the
      // same batch, so `pending` goes false and re-entry is already blocked.
      const parts: MessagePart[] = [
        {
          kind: "brief",
          label: multi ? "Revised answers" : "Revised answer",
          text: buildCorrection(questions, answers, row.message, declined),
        },
      ];
      actions.sendMessage(row.chatId, {
        text: composeMessageText(parts),
        parts,
        priority: chatStatus === "running" || chatStatus === "waiting" ? "next" : undefined,
      });
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
    if (
      chatStatus === "running" ||
      chatStatus === "waiting" ||
      chatStatus === "awaiting-input"
    ) {
      actions.interrupt(row.chatId);
    }
    setSelected({});
    setFreeText({});
    setCustom({});
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

  const toggle = (qi: number, id: string, single: boolean) => {
    touch();
    // On a pick-one question the custom row is just another radio, so choosing a
    // listed option unchecks it — the typed text stays put in case they come back.
    if (single) setCustom((c) => (c[qi] ? { ...c, [qi]: false } : c));
    setSelected((s) => {
      const cur = s[qi] ?? [];
      if (single) return { ...s, [qi]: cur.includes(id) ? [] : [id] };
      return { ...s, [qi]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });
  };

  /** Check the custom row — from its radio, its label, or the caret landing in it. */
  const pickCustom = (qi: number, single: boolean) => {
    touch();
    if (single) setSelected((s) => (s[qi]?.length ? { ...s, [qi]: [] } : s));
    setCustom((c) => (c[qi] ? c : { ...c, [qi]: true }));
  };

  const noteFor = (qi: number) => (notes[qi] ?? "").trim() || undefined;

  /**
   * The chosen answer for one question — whatever is CHECKED, custom included.
   * On a pick-one question exactly one of them can be, so there's nothing to
   * arbitrate; on a multi-select the custom text joins the chosen labels.
   * Notes ride along with either, since they qualify the choice rather than
   * replace it.
   */
  const valueFor = (qi: number): OneAnswer | null => {
    const nt = noteFor(qi);
    const ft = (freeText[qi] ?? "").trim();
    // No options offered at all — the text field IS the question, and there's no
    // radio in front of it to check.
    if (!questions[qi]?.options.length) {
      return ft ? { questionIndex: qi, answer: ft, notes: nt } : null;
    }
    const sel = selected[qi] ?? [];
    const parts = sel.map((id) => labelOf(qi, id));
    if (custom[qi] && ft) parts.push(ft);
    if (!parts.length) return null;
    return { questionIndex: qi, answer: parts.join(", "), optionId: sel[0], notes: nt };
  };

  const answeredCount = questions.filter((_, qi) => valueFor(qi) !== null).length;
  const allAnswered = answeredCount === questions.length;

  /** Submit every question at once — the one send path for every card shape. */
  const submitAll = () => {
    if (!allAnswered) return;
    send(questions.map((_, qi) => valueFor(qi)!));
  };

  /**
   * What the footer button says. A single-question card names the act ("Send
   * answer"); a multi-question one has to report progress, because the button is
   * disabled until the last question is answered and "Submit" alone gives no
   * clue which one is still empty.
   */
  const submitLabel = reverting
    ? "Send correction"
    : multi
      ? `Submit answers (${answeredCount}/${questions.length})`
      : "Send answer";

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
          <span className="text-base text-primary">
            {multi ? (
              <>
                {provider} has some <span className="font-semibold text-accent-hi">questions</span>
              </>
            ) : questions[0]?.header ? (
              <>
                {provider} asks — <span className="font-semibold text-accent-hi">{questions[0].header}</span>
              </>
            ) : (
              <>
                {provider} has a <span className="font-semibold text-accent-hi">question</span>
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
            <p className="text-xs text-secondary">
              Agent stopped. {declined ? "You declined this." : `Previously: ${row.message ?? "—"}.`}{" "}
              Pick again — your answer is sent as a correction.
            </p>
          </div>
        )}

        {questions.map((q, qi) => {
          const sel = selected[qi] ?? [];
          // Checked only once there's something to send: an empty custom row is
          // not an answer (valueFor agrees), so it must not draw a filled radio
          // next to a Submit that stays disabled.
          const customSel = (custom[qi] ?? false) && (freeText[qi] ?? "").trim().length > 0;
          const picked = sel.length + (customSel ? 1 : 0);
          return (
            <div key={qi}>
              <div className="border-t border-line-soft px-3 py-2">
                {multi && q.header && (
                  <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-accent-hi">
                    {q.header}
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-secondary">
                  {q.question}
                </p>
                {/* Say the selection rule in words. The checkbox-vs-radio shape
                    is the only other cue, and it's a 16px difference that
                    nobody reads before their first click — which on a
                    multi-select is the click that matters. */}
                {pending && q.options.length > 0 && (
                  <p className="mt-1 text-xs text-muted">
                    {q.multiSelect ? "Select all that apply" : "Select one"}
                    {q.multiSelect && picked > 0 && (
                      <span className="text-accent-hi"> · {picked} selected</span>
                    )}
                  </p>
                )}
              </div>

              {pending && (
                <div className="flex flex-col gap-1.5 border-t border-line-soft bg-inset/60 px-3 py-2.5">
                  {q.options.map((o) => {
                    const isSel = sel.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        disabled={busy}
                        aria-pressed={isSel}
                        onClick={() => toggle(qi, o.id, !q.multiSelect)}
                        className={cn(
                          "group flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                          isSel
                            ? "border-accent-line bg-accent-ghost text-primary"
                            : "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary",
                        )}
                      >
                        <Marker checked={isSel} multi={q.multiSelect} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{o.label}</span>
                          {o.description && (
                            <span className="mt-0.5 block text-xs text-muted">{o.description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}

                  {/* The custom answer is the LAST OPTION, not a field beside
                      them: same row shape, same marker, and checking it unchecks
                      the rest. It used to be a bare input that silently beat any
                      option you'd already clicked — the option stayed visibly
                      selected while the typed text won, so the click looked
                      ignored. A radio you can see settles which one is going. */}
                  {q.options.length > 0 ? (
                    <div
                      onMouseDown={(e) => {
                        if (busy) return;
                        touch();
                        // The marker is the UNCHECK. On a multi-select, dropping
                        // the custom answer out of the set must not mean deleting
                        // the text you'd want back — and the listed options each
                        // uncheck by clicking them again, so this row needs the
                        // same move. Delegated off the row, since a nested
                        // button element can't live inside a clickable row.
                        if (customSel && (e.target as HTMLElement).closest("[data-marker]")) {
                          e.preventDefault();
                          setCustom((c) => ({ ...c, [qi]: false }));
                          return;
                        }
                        // Otherwise the whole row is the field: focus it wherever
                        // you press, but let a press on the input itself place
                        // the caret normally.
                        if (e.target !== customRefs.current[qi]) {
                          e.preventDefault();
                          customRefs.current[qi]?.focus();
                        }
                        pickCustom(qi, !q.multiSelect);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
                        customSel
                          ? "border-accent-line bg-accent-ghost"
                          : "border-line bg-panel-2 hover:border-line-strong",
                        busy && "opacity-45",
                      )}
                    >
                      <Marker checked={customSel} multi={q.multiSelect} />
                      <input
                        ref={(el) => {
                          customRefs.current[qi] = el;
                        }}
                        value={freeText[qi] ?? ""}
                        onChange={(e) => {
                          touch();
                          setFreeText((s) => ({ ...s, [qi]: e.target.value }));
                          if (e.target.value.trim()) pickCustom(qi, !q.multiSelect);
                        }}
                        onFocus={() => pickCustom(qi, !q.multiSelect)}
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && allAnswered) {
                            e.preventDefault();
                            submitAll();
                          }
                        }}
                        placeholder="Type a custom answer"
                        className={cn(
                          "min-w-0 flex-1 bg-transparent text-sm font-medium text-primary",
                          "placeholder:font-normal placeholder:text-faint focus:outline-none",
                        )}
                      />
                    </div>
                  ) : (
                    <input
                      value={freeText[qi] ?? ""}
                      onChange={(e) => {
                        touch();
                        setFreeText((s) => ({ ...s, [qi]: e.target.value }));
                      }}
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && allAnswered) {
                          e.preventDefault();
                          submitAll();
                        }
                      }}
                      placeholder="Type your answer"
                      className={cn(
                        "h-7 min-w-0 rounded-md border border-line bg-panel-2 px-2 text-sm text-primary",
                        "placeholder:text-faint focus:border-line-strong focus:outline-none",
                      )}
                    />
                  )}

                  {/* Notes stay a qualifier, below every choice: they ride WITH
                      whichever option is checked rather than being one. */}
                  <input
                    value={notes[qi] ?? ""}
                    onChange={(e) => {
                      touch();
                      setNotes((s) => ({ ...s, [qi]: e.target.value }));
                    }}
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && allAnswered) {
                        e.preventDefault();
                        submitAll();
                      }
                    }}
                    placeholder="Notes (optional) — sent with your answer"
                    className={cn(
                      "mt-1 h-7 min-w-0 rounded-md border border-line bg-panel-2 px-2 text-sm text-primary",
                      "placeholder:text-faint focus:border-line-strong focus:outline-none",
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}

        {/* One submit for every shape of card, plus the escape hatch. */}
        {pending && (
          <div className="flex items-center gap-2 border-t border-line-soft bg-inset/60 px-3 py-2.5">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<CornerDownLeft />}
              disabled={!allAnswered || busy}
              onClick={submitAll}
            >
              {submitLabel}
            </Button>
            {!allAnswered && (
              <span className="text-xs text-muted">
                {multi ? "Answer every question to continue" : "Pick an option or type an answer"}
              </span>
            )}
            <Button
              variant="link"
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={reverting ? () => setReverting(false) : decline}
            >
              {reverting ? "Cancel" : "Decline"}
            </Button>
          </div>
        )}

        {!pending && (declined || row.message || corrected) && (
          <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
            <p className="min-w-0 flex-1 text-xs text-muted">
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
                "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors [&_svg]:size-3",
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
