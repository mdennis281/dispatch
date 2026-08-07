import { describe, it, expect } from "vitest";
import { neutralQuestions, buildQuestionAnswer, answerSummary } from "./questions.js";

/** The multi-question payload the tool sends. */
const MULTI = {
  questions: [
    {
      header: "Approach",
      question: "Which approach?",
      multiSelect: false,
      options: [
        { label: "Rewrite", description: "start over" },
        { label: "Patch", description: "minimal change" },
      ],
    },
    {
      header: "Scope",
      question: "How much?",
      multiSelect: true,
      options: [{ label: "Server" }, { label: "Client" }],
    },
  ],
};

describe("neutralQuestions", () => {
  it("projects the questions array with positional ids", () => {
    expect(neutralQuestions(MULTI)).toEqual([
      {
        id: "0",
        header: "Approach",
        question: "Which approach?",
        multiSelect: false,
        allowOther: true,
        options: [
          { label: "Rewrite", description: "start over" },
          { label: "Patch", description: "minimal change" },
        ],
      },
      {
        id: "1",
        header: "Scope",
        question: "How much?",
        multiSelect: true,
        allowOther: true,
        options: [
          { label: "Server", description: undefined },
          { label: "Client", description: undefined },
        ],
      },
    ]);
  });

  it("treats a flat single-question payload as one question", () => {
    const out = neutralQuestions({ question: "Ready?", options: [{ label: "Yes" }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "0", question: "Ready?", options: [{ label: "Yes" }] });
  });

  it("falls back to the header when there is no question text", () => {
    expect(neutralQuestions({ questions: [{ header: "Pick one" }] })[0]).toMatchObject({
      header: "Pick one",
      question: "Pick one",
    });
  });
});

describe("buildQuestionAnswer", () => {
  it("keys answers by QUESTION TEXT, which is what the tool reads", () => {
    // Getting this key wrong doesn't error — the model is silently told nobody
    // answered — which is why it is pinned here.
    expect(
      buildQuestionAnswer(MULTI, [
        { questionId: "0", selected: ["Patch"] },
        { questionId: "1", selected: ["Server", "Client"] },
      ]).answers,
    ).toEqual({
      "Which approach?": "Patch",
      // Multi-select is comma-joined into the single string the tool expects.
      "How much?": "Server, Client",
    });
  });

  it("preserves the rest of the original input", () => {
    const out = buildQuestionAnswer(MULTI, [{ questionId: "0", selected: ["Patch"] }]);
    expect(out.questions).toBe(MULTI.questions);
  });

  it("appends free-text notes onto the chosen value", () => {
    expect(
      buildQuestionAnswer(MULTI, [
        { questionId: "0", selected: ["Patch"], notes: "keep it under 50 lines" },
      ]).answers,
    ).toEqual({ "Which approach?": "Patch — additional instructions: keep it under 50 lines" });
  });

  it("omits a question the human skipped rather than inventing an empty answer", () => {
    const answers = buildQuestionAnswer(MULTI, [
      { questionId: "0", selected: ["Patch"] },
      { questionId: "1", selected: [] },
    ]).answers as Record<string, string>;
    expect(Object.keys(answers)).toEqual(["Which approach?"]);
  });

  it("ignores an answer pointing at a question that does not exist", () => {
    expect(buildQuestionAnswer(MULTI, [{ questionId: "9", selected: ["x"] }]).answers).toEqual({});
  });

  it("answers a flat single-question payload", () => {
    const input = { question: "Ready?", options: [{ label: "Yes" }] };
    expect(buildQuestionAnswer(input, [{ questionId: "0", selected: ["Yes"] }]).answers).toEqual({
      "Ready?": "Yes",
    });
  });
});

describe("answerSummary", () => {
  it("shows a lone answer without a label", () => {
    expect(answerSummary(MULTI, [{ questionId: "0", selected: ["Patch"] }])).toBe("Patch");
  });

  it("labels each answer when several were given", () => {
    expect(
      answerSummary(MULTI, [
        { questionId: "0", selected: ["Patch"] },
        { questionId: "1", selected: ["Server"] },
      ]),
    ).toBe("Approach: Patch · Scope: Server");
  });

  it("is undefined when nothing was chosen", () => {
    expect(answerSummary(MULTI, [{ questionId: "0", selected: [] }])).toBeUndefined();
  });
});
