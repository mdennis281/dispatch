import { describe, it, expect } from "vitest";
import { reviewerStatus, ReviewerCredentialSchema } from "./reviewer.js";

describe("reviewerStatus — the one place the token is dropped", () => {
  it("never carries the token, whatever else it carries", () => {
    // This is the whole security property of the reviewer endpoints: the token
    // is write-only across the wire. If a field is ever added to the credential
    // and spread into the status by accident, this is what catches it.
    const status = reviewerStatus({
      login: "dispatch-reviewer",
      token: "github_pat_secret",
      addedAt: 10,
      verifiedAt: 20,
      verifiedLogin: "dispatch-reviewer",
    });
    expect(JSON.stringify(status)).not.toContain("github_pat_secret");
    expect(Object.keys(status).sort()).toEqual(
      ["addedAt", "configured", "login", "verifiedAt", "verifiedLogin"].sort(),
    );
  });

  it("reports an absent account as unconfigured rather than empty-ish", () => {
    expect(reviewerStatus(null)).toEqual({ configured: false });
    expect(reviewerStatus(undefined)).toEqual({ configured: false });
  });
});

describe("ReviewerCredentialSchema", () => {
  it("refuses a blank token — a stored empty secret reads as a corrupt file", () => {
    expect(
      ReviewerCredentialSchema.safeParse({ login: "x", token: "", addedAt: 1 }).success,
    ).toBe(false);
    expect(
      ReviewerCredentialSchema.safeParse({ login: "", token: "t", addedAt: 1 }).success,
    ).toBe(false);
  });
});
