import { describe, expect, it } from "vitest";
import { ARTIFACT_STORAGE_MAX_CHARS } from "@dispatch/shared";
import {
  ARTIFACT_CSP,
  ARTIFACT_MESSAGE_TAG,
  ARTIFACT_SANDBOX,
  asArtifactMessage,
  buildArtifactDocument,
} from "./artifactDoc.js";

describe("artifact sandbox", () => {
  it("never grants same-origin or top navigation", () => {
    // These two tokens are the whole boundary between agent-written script and
    // the Dispatch API. A frame with allow-scripts AND allow-same-origin can
    // remove its own sandbox attribute.
    expect(ARTIFACT_SANDBOX).toContain("allow-scripts");
    expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    expect(ARTIFACT_SANDBOX).not.toMatch(/allow-top-navigation/);
  });

  it("has no network: every source is the frame's own data: or blob: memory", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    for (const directive of ARTIFACT_CSP.split(";").map((d) => d.trim())) {
      // No scheme or host that reaches a network — ours ('self') included.
      expect(directive, directive).not.toMatch(/https?:|wss?:|\*|'self'|filesystem:/);
    }
    const sources = (name: string) =>
      ARTIFACT_CSP.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1);
    expect(sources("connect-src")).toEqual(["data:", "blob:"]);
    expect(sources("worker-src")).toEqual(["blob:"]);
    expect(sources("form-action")).toEqual(["'none'"]);
  });
});

describe("buildArtifactDocument", () => {
  it("puts the doctype and the CSP before any artifact markup", () => {
    const doc = buildArtifactDocument("html", '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>');
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    const ours = doc.indexOf(ARTIFACT_CSP);
    const theirs = doc.indexOf("default-src *");
    expect(ours).toBeGreaterThan(0);
    expect(ours).toBeLessThan(theirs);
  });

  it("wraps an svg in a page body, after the head", () => {
    const doc = buildArtifactDocument("svg", '<svg xmlns="http://www.w3.org/2000/svg" id="s"></svg>');
    expect(doc.indexOf("<body>")).toBeGreaterThan(doc.indexOf(ARTIFACT_CSP));
    expect(doc).toMatch(/<body><svg[^>]*id="s"><\/svg><\/body><\/html>$/);
  });

  it("cannot be closed early by a script tag in the bridge", () => {
    const doc = buildArtifactDocument("html", "");
    // Exactly one script element (the bridge), and it is closed once.
    const lower = doc.toLowerCase();
    expect(lower.split("<script").length - 1).toBe(1);
    expect(lower.split("</script").length - 1).toBe(1);
  });
});

describe("asArtifactMessage", () => {
  it("accepts only tagged error messages and clips them", () => {
    const msg = asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "error", message: "x".repeat(5000) });
    expect(msg?.kind === "error" && msg.message).toHaveLength(2000);
    expect(asArtifactMessage({ kind: "error", message: "untagged" })).toBeNull();
    expect(asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "navigate", message: "x" })).toBeNull();
    expect(asArtifactMessage("string")).toBeNull();
    expect(asArtifactMessage(null)).toBeNull();
  });

  it("accepts a well-formed storage write and drops a malformed one whole", () => {
    expect(
      asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "storage", clear: true, set: { a: "1", b: null } }),
    ).toEqual({ kind: "storage", clear: true, set: { a: "1", b: null } });
    // The page wrote this, so every field is checked.
    expect(asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "storage", set: { a: 1 } })).toBeNull();
    expect(asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "storage", set: ["a"] })).toBeNull();
    expect(
      asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "storage", set: { ["k".repeat(5000)]: "v" } }),
    ).toBeNull();
  });
});

/**
 * Run the bridge the way the frame would — but in Node, against a stub window —
 * so the storage shim's behaviour is tested rather than asserted.
 */
function runBridge(storage: Record<string, string> = {}) {
  const doc = buildArtifactDocument("html", "", storage);
  const code = doc.slice(doc.indexOf("<script>") + 8, doc.indexOf("</script>"));
  const posted: unknown[] = [];
  const win: Record<string, unknown> = {};
  const fakeParent = { postMessage: (m: unknown) => posted.push(m) };
  const run = new Function("window", "parent", "addEventListener", "console", code);
  run(win, fakeParent, () => {}, { error: () => {} });
  return {
    local: win.localStorage as Storage & Record<string, unknown>,
    session: win.sessionStorage as Storage,
    posted: posted as Array<Record<string, unknown>>,
  };
}

describe("the bridge's localStorage", () => {
  it("is seeded from the snapshot and reads synchronously", () => {
    const { local } = runBridge({ save: '{"level":3}' });
    expect(JSON.parse(local.getItem("save")!)).toEqual({ level: 3 });
    expect(local.length).toBe(1);
    expect(local.key(0)).toBe("save");
    expect(local.getItem("missing")).toBeNull();
  });

  it("writes through to the parent: set, remove, clear", () => {
    const { local, posted } = runBridge({ a: "1" });
    local.setItem("b", "2");
    local.removeItem("a");
    local.removeItem("never-there"); // no message for a no-op
    local.clear();
    expect(posted.map(({ kind, set, clear }) => ({ kind, set, clear }))).toEqual([
      { kind: "storage", set: { b: "2" }, clear: undefined },
      { kind: "storage", set: { a: null }, clear: undefined },
      { kind: "storage", set: {}, clear: true },
    ]);
    expect(posted.every((m) => m[ARTIFACT_MESSAGE_TAG] === true)).toBe(true);
  });

  it("supports named-property access like a real Storage", () => {
    const { local, posted } = runBridge();
    local.score = 7;
    expect(local.getItem("score")).toBe("7");
    expect(local.score).toBe("7");
    expect(Object.keys(local)).toEqual(["score"]);
    delete local.score;
    expect(local.getItem("score")).toBeNull();
    expect(posted).toHaveLength(2);
  });

  it("throws QuotaExceededError synchronously past the quota, and keeps the old value", () => {
    const { local, posted } = runBridge();
    local.setItem("k", "small");
    expect(() => local.setItem("k", "x".repeat(ARTIFACT_STORAGE_MAX_CHARS))).toThrow(
      expect.objectContaining({ name: "QuotaExceededError" }),
    );
    expect(local.getItem("k")).toBe("small");
    expect(posted).toHaveLength(1);
  });

  it("sessionStorage works but is never sent anywhere", () => {
    const { session, posted } = runBridge();
    session.setItem("tab", "1");
    expect(session.getItem("tab")).toBe("1");
    expect(posted).toHaveLength(0);
  });

  it("a stored value cannot close the bridge script", () => {
    const evil = "</script><script>parent.pwned=1</script>";
    const doc = buildArtifactDocument("html", "", { k: evil });
    const lower = doc.toLowerCase();
    expect(lower.split("<script").length - 1).toBe(1);
    expect(lower.split("</script").length - 1).toBe(1);
    expect(runBridge({ k: evil }).local.getItem("k")).toBe(evil);
  });
});
