import { describe, expect, it, vi } from "vitest";
import { classifyIp, IpGeo } from "./ip-geo.js";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const WHOIS = {
  success: true,
  city: "Buffalo",
  region: "New York",
  country: "United States",
  country_code: "US",
  connection: { isp: "Frontier Communications", org: "Frontier" },
  timezone: { id: "America/New_York" },
};

describe("classifyIp", () => {
  it("names loopback and LAN addresses without needing a lookup", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("10.0.0.90")).toBe("private");
    expect(classifyIp("192.168.1.5")).toBe("private");
    expect(classifyIp("172.20.0.4")).toBe("private");
    expect(classifyIp("172.32.0.4")).toBe("public");
    expect(classifyIp("100.90.0.1")).toBe("private");
    expect(classifyIp("fd00::1")).toBe("private");
  });

  it("sees through the ::ffff: prefix a dual-stack socket adds", () => {
    expect(classifyIp("::ffff:192.168.1.5")).toBe("private");
    expect(classifyIp("::ffff:8.8.8.8")).toBe("public");
  });

  it("returns unknown rather than guessing", () => {
    expect(classifyIp(undefined)).toBe("unknown");
    expect(classifyIp("not-an-ip")).toBe("unknown");
  });
});

describe("IpGeo", () => {
  it("maps a provider response onto the session network shape", async () => {
    const fetchImpl = vi.fn(async () => ok(WHOIS));
    const geo = new IpGeo({ fetch: fetchImpl, now: () => 1_000 });
    expect(await geo.describe("8.8.8.8", true)).toEqual({
      scope: "public", lookedUpAt: 1_000, isp: "Frontier Communications", org: "Frontier",
      city: "Buffalo", region: "New York", country: "United States", countryCode: "US",
      timezone: "America/New_York",
    });
  });

  it("never calls out for a non-public address", async () => {
    const fetchImpl = vi.fn(async () => ok(WHOIS));
    const geo = new IpGeo({ fetch: fetchImpl });
    expect(await geo.describe("10.0.0.90", true)).toEqual({ scope: "private" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls out when the lookup is switched off", async () => {
    const fetchImpl = vi.fn(async () => ok(WHOIS));
    const geo = new IpGeo({ fetch: fetchImpl });
    expect(await geo.describe("8.8.8.8", false)).toEqual({ scope: "public" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches, so a settings reload does not re-query the provider", async () => {
    const fetchImpl = vi.fn(async () => ok(WHOIS));
    const geo = new IpGeo({ fetch: fetchImpl, now: () => 1_000 });
    await geo.describe("8.8.8.8", true);
    await geo.describe("::ffff:8.8.8.8", true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent lookups of one shared public IP", async () => {
    const fetchImpl = vi.fn(async () => ok(WHOIS));
    const geo = new IpGeo({ fetch: fetchImpl });
    await Promise.all([geo.describe("8.8.8.8", true), geo.describe("8.8.8.8", true), geo.describe("8.8.8.8", true)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // A box with no outbound internet must still render its session list.
  it("reports a failure as a value rather than throwing", async () => {
    const geo = new IpGeo({ fetch: async () => { throw new Error("ENOTFOUND"); }, now: () => 5 });
    const network = await geo.describe("8.8.8.8", true);
    expect(network).toEqual({ scope: "public", lookedUpAt: 5, error: "ENOTFOUND" });
  });

  it("treats a provider-level failure body as a failure", async () => {
    const geo = new IpGeo({ fetch: async () => ok({ success: false, message: "Rate limit" }), now: () => 5 });
    expect((await geo.describe("8.8.8.8", true)).error).toBe("Rate limit");
  });

  it("retries a failed lookup sooner than a successful one", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const geo = new IpGeo({ fetch: fetchImpl, now: () => now });
    await geo.describe("8.8.8.8", true);
    now = 9 * 60 * 1000;
    await geo.describe("8.8.8.8", true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 11 * 60 * 1000;
    await geo.describe("8.8.8.8", true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
