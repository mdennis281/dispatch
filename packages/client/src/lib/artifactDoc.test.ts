import { describe, expect, it } from "vitest";
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

  it("has no network: no connect, no remote script, image, font or media", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    for (const directive of ARTIFACT_CSP.split(";").map((d) => d.trim())) {
      expect(directive, directive).not.toMatch(/https?:|\*|'self'/);
    }
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
    expect(asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "error", message: "x".repeat(5000) })?.message).toHaveLength(2000);
    expect(asArtifactMessage({ kind: "error", message: "untagged" })).toBeNull();
    expect(asArtifactMessage({ [ARTIFACT_MESSAGE_TAG]: true, kind: "navigate", message: "x" })).toBeNull();
    expect(asArtifactMessage("string")).toBeNull();
    expect(asArtifactMessage(null)).toBeNull();
  });
});
