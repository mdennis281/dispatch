import { describe, expect, it } from "vitest";
import type { HarnessToolGuard } from "./harness.js";
import { catchToolGuard, composeToolGuards, guardRecoveryInput } from "./harness-guard.js";

describe("harness-neutral tool guard", () => {
  it.each(["in-place", "restart-turn"] as const)(
    "describes a blocked call with %s continuation",
    async (continuation) => {
      const blocked = await catchToolGuard(
        async (_name, input) => (input.command === "git push origin main" ? "use create_pr" : null),
        "Bash",
        { command: "git push origin main" },
        continuation,
      );

      expect(blocked).toEqual({
        type: "guard-blocked",
        toolName: "Bash",
        input: { command: "git push origin main" },
        reason: "use create_pr",
        continuation,
      });
    },
  );

  it("hands the guard the call's context, not a copy spliced into the input", async () => {
    const seen: unknown[] = [];
    await catchToolGuard(
      async (_name, input, ctx) => {
        seen.push(input, ctx);
        return null;
      },
      "Bash",
      { command: "ls" },
      "in-place",
      { cwd: "/repo", agentId: "a1", toolUseId: "t1" },
    );
    expect(seen).toEqual([{ command: "ls" }, { cwd: "/repo", agentId: "a1", toolUseId: "t1" }]);
  });

  it("turns a late catch into a safe continuation directive", async () => {
    const blocked = (await catchToolGuard(
      async () => "commit on a task branch",
      "Bash",
      { command: "git commit -m fix" },
      "restart-turn",
    ))!;

    expect(guardRecoveryInput([blocked])).toContain("Continue the task now");
    expect(guardRecoveryInput([blocked])).toContain("may have started");
    expect(guardRecoveryInput([blocked])).toContain("commit on a task branch");
  });
});

describe("composeToolGuards", () => {
  it("stops at the first refusal, so a later guard never sees a call that won't run", async () => {
    // The later guard stands in for the workflow guard, which burns one-shot
    // exemptions: consulted for a call an earlier guard refused, it would
    // spend the human's grant on nothing.
    const reached: string[] = [];
    const guard = composeToolGuards([
      async (name) => {
        reached.push(`first:${name}`);
        return name === "Edit" ? "no edits" : null;
      },
      async (name) => {
        reached.push(`last:${name}`);
        return null;
      },
    ]);
    expect(await guard("Edit", {}, {})).toBe("no edits");
    expect(await guard("Read", {}, {})).toBeNull();
    expect(reached).toEqual(["first:Edit", "first:Read", "last:Read"]);
  });

  it("skips a guard that throws rather than letting it take the tool surface down", async () => {
    const errors: unknown[] = [];
    const boom: HarnessToolGuard = async () => {
      throw new Error("stat failed");
    };
    const guard = composeToolGuards([boom, async () => "still refused"], (e) => errors.push(e));
    expect(await guard("Bash", {}, {})).toBe("still refused");
    expect(errors).toHaveLength(1);
  });
});
