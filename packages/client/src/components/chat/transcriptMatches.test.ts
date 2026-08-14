import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTranscriptMatches } from "./transcriptMatches.js";

interface FakeText {
  data: string;
  parentElement: { closest: (selector: string) => object | null };
}

interface FakeRange {
  start?: [FakeText, number];
  end?: [FakeText, number];
  setStart: (node: FakeText, offset: number) => void;
  setEnd: (node: FakeText, offset: number) => void;
}

function text(data: string, ignored = false): FakeText {
  return {
    data,
    parentElement: {
      closest: () => (ignored ? {} : null),
    },
  };
}

function rootWith(...nodes: FakeText[]): HTMLElement {
  const row = { nodes };
  return {
    querySelectorAll: () => [row],
  } as unknown as HTMLElement;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "NodeFilter", {
    configurable: true,
    value: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createTreeWalker(
        row: { nodes: FakeText[] },
        _what: number,
        filter: { acceptNode: (node: Node) => number },
      ) {
        let index = 0;
        return {
          nextNode() {
            while (index < row.nodes.length) {
              const node = row.nodes[index++];
              if (node && filter.acceptNode(node as unknown as Node) === 1) return node;
            }
            return null;
          },
        };
      },
      createRange(): FakeRange {
        return {
          setStart(node, offset) {
            this.start = [node, offset];
          },
          setEnd(node, offset) {
            this.end = [node, offset];
          },
        };
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "NodeFilter");
});

describe("findTranscriptMatches", () => {
  it("matches case-insensitively across adjacent Markdown text nodes", () => {
    const first = text("Search the ");
    const second = text("Transcript");
    const matches = findTranscriptMatches(rootWith(first, second), "THE TRANS");

    expect(matches).toHaveLength(1);
    const range = matches[0]!.range as unknown as FakeRange;
    expect(range.start).toEqual([first, 7]);
    expect(range.end).toEqual([second, 5]);
  });

  it("finds every non-overlapping match", () => {
    const node = text("find FIND finding");
    const matches = findTranscriptMatches(rootWith(node), "find");

    expect(matches).toHaveLength(3);
    expect(
      matches.map((match) => (match.range as unknown as FakeRange).start?.[1]),
    ).toEqual([0, 5, 10]);
  });

  it("does not search text inside ignored subtrees", () => {
    const matches = findTranscriptMatches(
      rootWith(text("visible "), text("secret", true), text(" result")),
      "secret",
    );

    expect(matches).toHaveLength(0);
  });
});
