import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ACTIVE_SESSIONS } from "@dispatch/shared";
import { loadConfig } from "./config.js";

describe("the concurrency cap", () => {
  it("defaults to the shared constant and reads the env override", () => {
    expect(loadConfig({}).maxActiveSessions).toBe(DEFAULT_MAX_ACTIVE_SESSIONS);
    expect(loadConfig({ DISPATCH_MAX_ACTIVE_SESSIONS: "12" }).maxActiveSessions).toBe(12);
  });

  it("clamps a degenerate value to a cap the broker would actually honour", () => {
    // `0` is the typo for "unlimited", and an unclamped one reached
    // `/api/settings/defaults` → the settings field, which then told the operator
    // `blank = 0` while the broker ran at 1.
    expect(loadConfig({ DISPATCH_MAX_ACTIVE_SESSIONS: "0" }).maxActiveSessions).toBe(1);
    expect(loadConfig({ DISPATCH_MAX_ACTIVE_SESSIONS: "-4" }).maxActiveSessions).toBe(1);
    // Unparseable is not degenerate — it means "unset", which is the default.
    expect(loadConfig({ DISPATCH_MAX_ACTIVE_SESSIONS: "lots" }).maxActiveSessions).toBe(
      DEFAULT_MAX_ACTIVE_SESSIONS,
    );
  });
});

describe("server bind host", () => {
  it("stays on loopback unless host mode is explicitly enabled", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it("honours the explicit host-mode environment variable", () => {
    expect(loadConfig({ DISPATCH_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
