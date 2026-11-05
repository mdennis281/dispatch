import { describe, expect, it } from "vitest";
import { parseCodexLoginOutput } from "./login-flow.js";

describe("parseCodexLoginOutput", () => {
  it("takes the sign-in page, not the loopback server's own address", () => {
    const out = [
      "Starting local login server on http://localhost:1455.",
      "If your browser did not open, navigate to this URL to authenticate:",
      "",
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=x",
    ].join("\n");
    const p = parseCodexLoginOutput(out);
    expect(p.url).toBe("https://auth.openai.com/oauth/authorize?response_type=code&client_id=x");
    // The callback is the host's localhost, which a phone cannot reach.
    expect(p.hint).toMatch(/machine Dispatch runs on/);
    expect(p.awaitingCode).toBeUndefined();
  });
});
