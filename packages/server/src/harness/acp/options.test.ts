import { describe, it, expect } from "vitest";
import { toAcpMode, pickPermissionOption, toInstructionBlock, toAcpEffort } from "./options.js";
import { resolveGooseRuntime, gooseCandidates } from "./runtime.js";

/** The four options goose 1.51.0 actually offers, captured from a live run. */
const GOOSE_OPTIONS = [
  { optionId: "allow_always", name: "allow_always", kind: "allow_always" },
  { optionId: "allow_once", name: "allow_once", kind: "allow_once" },
  { optionId: "reject_once", name: "reject_once", kind: "reject_once" },
  { optionId: "reject_always", name: "reject_always", kind: "reject_always" },
];

describe("toAcpMode", () => {
  it("maps plan onto the agent's no-tools mode", () => {
    // Stronger than Claude's plan mode: the agent refuses tools rather than
    // the model being asked not to use them.
    expect(toAcpMode("plan")).toBe("chat");
  });

  it("stops asking only for the two modes that mean that", () => {
    expect(toAcpMode("dontAsk")).toBe("auto");
    expect(toAcpMode("bypassPermissions")).toBe("auto");
  });

  it("biases toward asking for the modes ACP cannot express", () => {
    // ACP has no per-tool-kind axis, so acceptEdits cannot mean "edits pass,
    // commands prompt". Mapping it to `auto` would silently auto-approve
    // commands — a safety regression — so all three collapse onto asking.
    expect(toAcpMode("acceptEdits")).toBe("smart_approve");
    expect(toAcpMode("auto")).toBe("smart_approve");
    expect(toAcpMode("default")).toBe("smart_approve");
  });
});

describe("pickPermissionOption", () => {
  it("answers with the once variants, never the standing grant", () => {
    // allow_always would outlive the decision the human made and hide every
    // following call from Dispatch's workflow guard.
    expect(pickPermissionOption(GOOSE_OPTIONS, "allow")).toBe("allow_once");
    expect(pickPermissionOption(GOOSE_OPTIONS, "deny")).toBe("reject_once");
  });

  it("matches on kind rather than on the agent's id spelling", () => {
    const odd = [
      { optionId: "x1", kind: "allow_once" },
      { optionId: "x2", kind: "reject_once" },
    ];
    expect(pickPermissionOption(odd, "allow")).toBe("x1");
    expect(pickPermissionOption(odd, "deny")).toBe("x2");
  });

  it("accepts deny as a spelling of reject", () => {
    const opts = [{ optionId: "a", kind: "allow" }, { optionId: "d", kind: "deny" }];
    expect(pickPermissionOption(opts, "deny")).toBe("d");
  });

  it("does not read 'disallow' as an allow", () => {
    // Regression: matching was a bare substring test, and "allow" is a
    // substring of "disallow" — so an ALLOW decision was answered with the
    // DENY option. goose's own four kinds never hit this, but the function
    // exists to generalise to the next ACP agent, and silently inverting a
    // permission answer is the worst possible way to discover that.
    const opts = [
      { optionId: "x1", kind: "disallow_once" },
      { optionId: "x2", kind: "allow_once" },
    ];
    expect(pickPermissionOption(opts, "allow")).toBe("x2");
    expect(pickPermissionOption(opts, "deny")).toBe("x1");
  });

  it("understands other agents' vocabularies", () => {
    const opts = [
      { optionId: "y", kind: "approve_once" },
      { optionId: "n", kind: "decline_once" },
    ];
    expect(pickPermissionOption(opts, "allow")).toBe("y");
    expect(pickPermissionOption(opts, "deny")).toBe("n");
  });

  it("falls back to an option rather than returning nothing", () => {
    // An unanswered permission request hangs the turn forever, so any answer
    // beats no answer.
    expect(pickPermissionOption([{ optionId: "only" }], "allow")).toBe("only");
    expect(pickPermissionOption([], "allow")).toBeUndefined();
  });
});

describe("toInstructionBlock", () => {
  it("joins appends with a blank line", () => {
    expect(toInstructionBlock(["a", "b"])).toBe("a\n\nb");
  });

  it("returns undefined rather than an empty block", () => {
    expect(toInstructionBlock([])).toBeUndefined();
    expect(toInstructionBlock(["", "  "])).toBeUndefined();
  });
});

describe("toAcpEffort", () => {
  it("drops effort because ACP has no field for it", () => {
    expect(toAcpEffort("max")).toBeUndefined();
  });
});

describe("resolveGooseRuntime", () => {
  it("takes an explicit override verbatim", () => {
    const rt = resolveGooseRuntime(
      { DISPATCH_GOOSE_PATH: "/custom/goose" },
      { versionOf: () => "1.51.0", exists: () => false, candidates: () => [] },
    );
    expect(rt).toMatchObject({ path: "/custom/goose", source: "override", available: true });
  });

  it("reports missing rather than throwing when nothing is installed", () => {
    // A greyed-out provider is recoverable; a boot crash is not.
    const rt = resolveGooseRuntime({}, { exists: () => false, candidates: () => ["/nope"] });
    expect(rt).toMatchObject({ kind: "goose", source: "missing", available: false });
    expect(rt.path).toBeUndefined();
  });

  it("skips a candidate it cannot get a version out of", () => {
    // Spawning an unidentifiable binary turns "not installed" into a hang.
    const rt = resolveGooseRuntime(
      {},
      {
        exists: () => true,
        candidates: () => ["/bad", "/good"],
        versionOf: (p) => (p === "/good" ? "1.51.0" : undefined),
      },
    );
    expect(rt).toMatchObject({ path: "/good", version: "1.51.0", source: "installed" });
  });
});

describe("gooseCandidates", () => {
  it("never offers a Downloads path", () => {
    // A stale unzip in Downloads must not silently become the agent runtime.
    const all = gooseCandidates({
      HOME: "/home/u",
      USERPROFILE: "C:\\Users\\u",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      PATH: "",
    });
    expect(all.some((p) => /downloads/i.test(p))).toBe(false);
    expect(all.length).toBeGreaterThan(0);
  });
});
