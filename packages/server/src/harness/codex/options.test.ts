import { describe, it, expect } from "vitest";
import { toCodexPosture, clampEffort, toDeveloperInstructions } from "./options.js";
import { compareCodexVersions, resolveCodexRuntime } from "./runtime.js";

describe("toCodexPosture", () => {
  it("makes plan mode hard read-only", () => {
    // Stricter than Claude, which only asks the model not to write.
    expect(toCodexPosture("plan")).toEqual({ approvalPolicy: "untrusted", sandbox: "read-only" });
  });

  it("lets workspace edits through but still prompts for commands", () => {
    expect(toCodexPosture("acceptEdits")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("stops prompting but stays inside the workspace for dontAsk", () => {
    expect(toCodexPosture("dontAsk")).toEqual({
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  });

  it("only opens the sandbox fully for explicit bypass", () => {
    expect(toCodexPosture("bypassPermissions")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("defaults to prompting inside the workspace", () => {
    expect(toCodexPosture("default")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(toCodexPosture("auto")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });
});

describe("clampEffort", () => {
  it("passes an effort the model supports straight through", () => {
    expect(clampEffort("high", ["low", "medium", "high", "xhigh"])).toBe("high");
  });

  it("falls back to the highest supported level below the request", () => {
    // "max" asked for, model tops out at xhigh → give it everything it has.
    expect(clampEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  it("falls back downward through gaps in the ladder", () => {
    expect(clampEffort("xhigh", ["low", "high"])).toBe("high");
  });

  it("uses the first supported level when nothing is below the request", () => {
    expect(clampEffort("low", ["medium", "high"])).toBe("medium");
  });

  it("passes through unchanged when the model advertises nothing", () => {
    expect(clampEffort("high", [])).toBe("high");
  });
});

describe("toDeveloperInstructions", () => {
  it("joins the appends with a blank line between them", () => {
    expect(toDeveloperInstructions(["one", "two"])).toBe("one\n\ntwo");
  });

  it("drops empties so a blank block cannot open the prompt", () => {
    expect(toDeveloperInstructions(["", "  ", "real"])).toBe("real");
  });

  it("is undefined when there is nothing to say", () => {
    expect(toDeveloperInstructions([])).toBeUndefined();
    expect(toDeveloperInstructions(["", " "])).toBeUndefined();
  });
});

describe("compareCodexVersions", () => {
  it("orders by numeric core segments", () => {
    expect(compareCodexVersions("0.147.0", "0.146.9")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.146.0", "0.147.0")).toBeLessThan(0);
    expect(compareCodexVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareCodexVersions("0.147.0", "0.147.0-alpha.6")).toBeGreaterThan(0);
  });

  it("orders prereleases numerically, not lexically", () => {
    // The bug this guards: "alpha.10" < "alpha.9" under string comparison.
    expect(compareCodexVersions("0.147.0-alpha.10", "0.147.0-alpha.9")).toBeGreaterThan(0);
  });

  it("orders named prerelease stages", () => {
    expect(compareCodexVersions("1.0.0-beta.1", "1.0.0-alpha.1")).toBeGreaterThan(0);
  });
});

describe("resolveCodexRuntime", () => {
  const deps = (versions: Record<string, string | undefined>) => ({
    exists: (p: string) => p in versions,
    versionOf: (p: string) => versions[p],
    candidates: () => Object.keys(versions),
  });

  it("uses an explicit override verbatim", () => {
    const rt = resolveCodexRuntime(
      { DISPATCH_CODEX_PATH: "/custom/codex" } as NodeJS.ProcessEnv,
      deps({ "/custom/codex": "9.9.9" }),
    );
    expect(rt).toMatchObject({ path: "/custom/codex", source: "override", available: true });
  });

  it("picks the newest binary across install locations", () => {
    // The real case on the machine this was built for: the plugin app-server's
    // copy was newer than the VS Code extension's.
    const rt = resolveCodexRuntime(
      {} as NodeJS.ProcessEnv,
      deps({
        "/vscode/codex": "0.146.0-alpha.9.2",
        "/plugins/codex": "0.147.0-alpha.6.5",
      }),
    );
    expect(rt).toMatchObject({ path: "/plugins/codex", version: "0.147.0-alpha.6.5" });
  });

  it("skips a candidate whose version cannot be read", () => {
    // An unreadable version means we can't prove it speaks the v2 protocol.
    const rt = resolveCodexRuntime(
      {} as NodeJS.ProcessEnv,
      deps({ "/broken/codex": undefined, "/good/codex": "0.140.0" }),
    );
    expect(rt.path).toBe("/good/codex");
  });

  it("reports unavailable rather than throwing when Codex isn't installed", () => {
    const rt = resolveCodexRuntime({} as NodeJS.ProcessEnv, deps({}));
    expect(rt).toEqual({ kind: "codex", source: "missing", available: false });
  });
});
