import { describe, expect, it } from "vitest";
import { probeCodexLogin, type RunProbe } from "./login.js";

function ran(over: Partial<Awaited<ReturnType<RunProbe>>>): RunProbe {
  return async () => ({ code: 0, stdout: "", stderr: "", ...over });
}

describe("probeCodexLogin", () => {
  it("exit 0 is logged in, with the method scraped from the prose", async () => {
    const run = ran({ stdout: "Logged in using ChatGPT\n" });
    expect(await probeCodexLogin("/x/codex", {}, run)).toEqual({
      checked: true,
      loggedIn: true,
      method: "ChatGPT",
    });
  });

  it("non-zero is logged out, and the fix is named", async () => {
    const run = ran({ code: 1, stderr: "Not logged in\n" });
    const status = await probeCodexLogin("/x/codex", {}, run);
    expect(status).toMatchObject({ checked: true, loggedIn: false });
    expect(status.error).toContain("codex login");
  });
});

describe("CodexHarness.probeLogin", () => {
  it("reports an unrunnable binary as unchecked rather than throwing", async () => {
    const status = await probeCodexLogin("/x/codex", {}, async () => ({
      code: null,
      stdout: "",
      stderr: "",
      spawnError: "spawn /x/codex ENOENT",
    }));
    expect(status).toMatchObject({ checked: false, loggedIn: false });
    expect(status.error).toContain("ENOENT");
  });
});
