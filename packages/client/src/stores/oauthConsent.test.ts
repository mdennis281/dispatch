import { describe, expect, it } from "vitest";
import { parseOAuthHash, useOAuthConsent } from "./oauthConsent.js";

describe("parseOAuthHash", () => {
  it("reads the consent nonce the authorize endpoint redirects with", () => {
    expect(parseOAuthHash("#oauth=abc_-123")).toEqual({ nonce: "abc_-123" });
  });

  it("reads the settings deep link and the plugin callback's error together", () => {
    expect(parseOAuthHash("#settings=plugins&oauthError=The+provider+refused")).toEqual({
      settings: "plugins",
      oauthError: "The provider refused",
    });
  });

  it("ignores unrelated hashes and empty values", () => {
    expect(parseOAuthHash("#chat=xyz")).toEqual({});
    expect(parseOAuthHash("#oauth=")).toEqual({});
    expect(parseOAuthHash("")).toEqual({});
  });
});

describe("useOAuthConsent", () => {
  it("holds one nonce until cleared", () => {
    useOAuthConsent.getState().begin("n1");
    expect(useOAuthConsent.getState().nonce).toBe("n1");
    useOAuthConsent.getState().clear();
    expect(useOAuthConsent.getState().nonce).toBeNull();
  });
});
