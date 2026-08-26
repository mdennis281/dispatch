import { describe, expect, it } from "vitest";
import { catchToolGuard, guardRecoveryInput } from "./guard.js";

describe("harness-neutral tool guard", () => {
  it.each(["in-place", "restart-turn"] as const)(
    "describes a blocked call with %s continuation",
    (continuation) => {
      const blocked = catchToolGuard(
        (_name, input) => (input.command === "git push origin main" ? "use create_pr" : null),
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

  it("turns a late catch into a safe continuation directive", () => {
    const blocked = catchToolGuard(
      () => "commit on a task branch",
      "Bash",
      { command: "git commit -m fix" },
      "restart-turn",
    )!;

    expect(guardRecoveryInput([blocked])).toContain("Continue the task now");
    expect(guardRecoveryInput([blocked])).toContain("may have started");
    expect(guardRecoveryInput([blocked])).toContain("commit on a task branch");
  });
});
