import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server bind host", () => {
  it("stays on loopback unless host mode is explicitly enabled", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it("honours the explicit host-mode environment variable", () => {
    expect(loadConfig({ DISPATCH_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
