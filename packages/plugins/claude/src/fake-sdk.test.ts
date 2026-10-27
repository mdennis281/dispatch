import { describe, expect, it } from "vitest";
import { ClaudeHarness } from "./index.js";
import { makeFakeQuery } from "./fake-sdk.js";

describe("the E2E fake SDK", () => {
  it("answers a one-shot string prompt once, not once per character", async () => {
    // generateText hands the SDK a plain string; iterated as the streaming
    // input it would echo "Echo: " for every character of the prompt.
    const harness = new ClaudeHarness({ query: makeFakeQuery() });
    const text = await harness.generateText({ prompt: "name this chat", purpose: "title" });
    expect(text).toBe("Echo: name this chat");
  });
});
