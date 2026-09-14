import { describe, expect, it } from "vitest";
import { splitStreaming } from "./streamingBlocks.js";

describe("splitStreaming", () => {
  it("keeps a single paragraph entirely in the tail", () => {
    expect(splitStreaming("Hello there, still typ")).toEqual({
      settled: [],
      tail: "Hello there, still typ",
    });
    expect(splitStreaming("")).toEqual({ settled: [], tail: "" });
  });

  it("settles a paragraph once the next one has started", () => {
    expect(splitStreaming("First para.\n\nSec")).toEqual({
      settled: ["First para.\n"],
      tail: "Sec",
    });
  });

  it("waits for the next line's first character before cutting", () => {
    // The next line could still turn out to be indented — a continuation.
    expect(splitStreaming("First para.\n\n")).toEqual({
      settled: [],
      tail: "First para.\n\n",
    });
    expect(splitStreaming("First para.\n\n\n")).toEqual({
      settled: [],
      tail: "First para.\n\n\n",
    });
  });

  it("never cuts inside a fenced code block", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    expect(splitStreaming(text)).toEqual({
      settled: ["Intro.\n"],
      tail: "```ts\nconst a = 1;\n\nconst b = 2;\n",
    });
  });

  it("settles a fenced block once it closes and prose resumes", () => {
    const text = "```ts\nconst a = 1;\n```\n\nAfter";
    expect(splitStreaming(text)).toEqual({
      settled: ["```ts\nconst a = 1;\n```\n"],
      tail: "After",
    });
  });

  it("only closes a fence with the same character and at least the same length", () => {
    // A ``` inside a ```` fence is content; ~~~ never closes a backtick fence.
    const text = "````md\n```\nnested\n```\n\nstill inside\n````\n\nOut";
    expect(splitStreaming(text)).toEqual({
      settled: ["````md\n```\nnested\n```\n\nstill inside\n````\n"],
      tail: "Out",
    });
    expect(splitStreaming("```\ncode\n~~~\n\nmore")).toEqual({
      settled: [],
      tail: "```\ncode\n~~~\n\nmore",
    });
  });

  it("keeps an indented continuation with the block above", () => {
    const text = "- item one\n\n  its second paragraph\n\nNext";
    expect(splitStreaming(text)).toEqual({
      settled: ["- item one\n\n  its second paragraph\n"],
      tail: "Next",
    });
  });

  it("keeps a loose list together across blank lines", () => {
    const text = "1. first\n\n2. second\n\n3. thi";
    expect(splitStreaming(text)).toEqual({
      settled: [],
      tail: "1. first\n\n2. second\n\n3. thi",
    });
    // …but a paragraph after the list does end it.
    expect(splitStreaming("- a\n\n- b\n\nDone")).toEqual({
      settled: ["- a\n\n- b\n"],
      tail: "Done",
    });
  });

  it("settles every finished block of a long reply and leaves only the last", () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}.`);
    const text = paras.join("\n\n") + "\n\nTail in prog";
    const { settled, tail } = splitStreaming(text);
    expect(settled).toEqual(paras.map((p) => `${p}\n`));
    expect(tail).toBe("Tail in prog");
  });

  it("is append-stable: settled blocks never change once cut", () => {
    const full = "One.\n\n## Two\n\n```js\nx()\n\ny()\n```\n\n- a\n- b\n\nThree.";
    let prev: string[] = [];
    for (let n = 1; n <= full.length; n++) {
      const { settled } = splitStreaming(full.slice(0, n));
      // Every previously settled block is still there, verbatim, in order.
      expect(settled.slice(0, prev.length)).toEqual(prev);
      prev = settled;
    }
    expect(prev).toEqual(["One.\n", "## Two\n", "```js\nx()\n\ny()\n```\n", "- a\n- b\n"]);
  });
});
