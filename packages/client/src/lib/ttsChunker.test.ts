import { describe, it, expect } from "vitest";
import { SentenceChunker, cleanForSpeech } from "./ttsChunker.js";

/** Feed a reply as token-sized deltas and collect what the chunker emits, then the tail. */
function speak(deltas: string[]): { sentences: string[]; tail: string | null } {
  const c = new SentenceChunker();
  const sentences: string[] = [];
  for (const d of deltas) sentences.push(...c.feed(d));
  return { sentences, tail: c.flush() };
}

describe("SentenceChunker", () => {
  it("emits a sentence only once the character AFTER its terminator has arrived", () => {
    const { sentences, tail } = speak(["Hello wor", "ld. How are", " you? Fi", "ne"]);
    expect(sentences).toEqual(["Hello world.", "How are you?"]);
    expect(tail).toBe("Fine");
  });

  it("does not split a decimal or an abbreviation mid-token", () => {
    const { sentences, tail } = speak(["Pi is 3.", "14 and that", " is all."]);
    expect(sentences).toEqual([]);
    expect(tail).toBe("Pi is 3.14 and that is all.");
  });

  it("treats a line break as a boundary and strips markdown on the way out", () => {
    const { sentences, tail } = speak(["**Done**\n", "- first `thing`\n- [a link](http://x)\n", "## Head", "ing\nend"]);
    expect(sentences).toEqual(["Done", "first thing", "a link", "Heading"]);
    expect(tail).toBe("end");
  });

  it("stops at a horizontal rule: the spoken part precedes it, the rest is never said", () => {
    const c = new SentenceChunker();
    const out = [...c.feed("Short answer here.\n\n--"), ...c.feed("-\n\nLong detail. More detail.")];
    expect(out).toEqual(["Short answer here."]);
    expect(c.stoppedAtRule).toBe(true);
    expect(c.feed(" Even more.")).toEqual([]);
    expect(c.flush()).toBeNull();
    // A flush resets the stop for the next reply.
    expect(c.feed("Next reply. ")).toEqual(["Next reply."]);
  });

  it("recognises a rule that arrives only at flush, with no newline after it", () => {
    // "Two" completes at the newline that starts the rule's line; the rule
    // itself is then the whole tail, and the tail says nothing.
    const { sentences, tail } = speak(["One. Two", "\n***"]);
    expect(sentences).toEqual(["One.", "Two"]);
    expect(tail).toBeNull();
    expect(speak(["Only --- here"]).tail).toBe("Only --- here");
    expect(speak(["Gone", "\n", "---"]).tail).toBeNull();
  });

  it("does not mistake a dash-prefixed line or a longer run for a rule", () => {
    const { sentences } = speak(["Note:\n", "-- not a rule\n", "---- also text\n"]);
    expect(sentences).toEqual(["Note:", "-- not a rule", "---- also text"]);
  });

  it("drops fenced code whole", () => {
    expect(cleanForSpeech("Run this:\n```sh\nrm -rf /\n```\nthen stop.")).toBe("Run this:\n \nthen stop.");
  });
});
