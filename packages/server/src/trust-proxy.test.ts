import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { describeTrustProxy, parseTrustProxy, trustProxyError } from "./trust-proxy.js";

describe("the trusted-proxy setting", () => {
  it("says nothing when unset, so Fastify keeps its own default", () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy("")).toBeUndefined();
    expect(parseTrustProxy("   ")).toBeUndefined();
  });

  it("reads the off spellings as an explicit no — including `0` hops", () => {
    for (const off of ["false", "off", "no", "0", "OFF"]) expect(parseTrustProxy(off)).toBe(false);
  });

  it("reads the on spellings as blanket trust", () => {
    for (const on of ["true", "on", "yes", "TRUE"]) expect(parseTrustProxy(on)).toBe(true);
  });

  it("reads addresses, ranges and keywords as a list", () => {
    expect(parseTrustProxy("10.0.0.1")).toEqual(["10.0.0.1"]);
    expect(parseTrustProxy(" 10.0.0.0/24 , loopback ,fd00::/8 ")).toEqual(["10.0.0.0/24", "loopback", "fd00::/8"]);
  });
});

describe("rejecting a value before it can reach proxy-addr", () => {
  it("passes everything the parser accepts", () => {
    for (const ok of ["", "off", "true", "10.0.0.1", "10.0.0.0/24,loopback", "fd00::/8"]) {
      expect(trustProxyError(ok)).toBeNull();
    }
  });

  it("tells someone who typed a hop count what to type instead", () => {
    expect(trustProxyError("1")).toMatch(/hop count/);
    expect(parseTrustProxy("1")).toBeUndefined();
    // `0` stays an off-spelling — it is the one number that means what it says.
    expect(trustProxyError("0")).toBeNull();
  });

  it("names the entries that are not addresses", () => {
    expect(trustProxyError("haproxy.lan")).toMatch(/haproxy\.lan/);
    expect(trustProxyError("10.0.0.1, nonsense")).toMatch(/nonsense/);
    expect(trustProxyError("10.0.0.1, 10.0.0.1")).toBeNull();
    expect(trustProxyError("999.0.0.1")).toMatch(/999\.0\.0\.1/);
    expect(trustProxyError("10.0.0.0/64")).toMatch(/10\.0\.0\.0\/64/);
  });

  /**
   * The reason this validation exists: proxy-addr THROWS on a bad entry, from
   * inside the Fastify constructor — so an unvalidated typo in Settings is a
   * server that no longer boots, configured from a panel you can no longer
   * reach. Driven through the real constructor so a looser regex here cannot
   * quietly reintroduce the crash.
   */
  it("only ever produces a value Fastify can be constructed with", () => {
    for (const ok of ["10.0.0.1", "10.0.0.0/24", "loopback", "fd00::/8", "true", "off"]) {
      expect(() => Fastify({ trustProxy: parseTrustProxy(ok) })).not.toThrow();
    }
    expect(() => Fastify({ trustProxy: ["haproxy.lan"] })).toThrow();
    expect(parseTrustProxy("haproxy.lan")).toBeUndefined();
  });
});

/**
 * The boot banner, the settings panel and the "restart to apply" notice all read
 * this, and all three were wrong when it echoed the input instead: `off` is a
 * VALID setting whose outcome is "nobody", so the raw string announced that
 * `off` was being trusted while Fastify had `trustProxy: false`.
 */
describe("describing what is actually trusted", () => {
  it("is empty whenever the outcome is nobody, however that was spelled", () => {
    for (const nobody of ["", "   ", undefined, "off", "false", "no", "0", "haproxy.lan", "2"]) {
      expect(describeTrustProxy(nobody)).toBe("");
    }
  });

  it("names the upstreams, and blanket trust in words", () => {
    expect(describeTrustProxy("10.0.0.1")).toBe("10.0.0.1");
    expect(describeTrustProxy(" 10.0.0.0/24 ,loopback ")).toBe("10.0.0.0/24, loopback");
    expect(describeTrustProxy("true")).toBe("any upstream");
  });

  it("is canonical, so equal outcomes compare equal", () => {
    // What `pendingRestart` is computed from — a restart notice must not appear
    // because someone retyped the same value with a space in it.
    expect(describeTrustProxy(" 10.0.0.1")).toBe(describeTrustProxy("10.0.0.1"));
    expect(describeTrustProxy("off")).toBe(describeTrustProxy(""));
  });

  it("never claims trust Fastify was not given", () => {
    for (const raw of ["", "off", "0", "10.0.0.1", "true", "nonsense"]) {
      expect(Boolean(describeTrustProxy(raw))).toBe(Boolean(parseTrustProxy(raw)));
    }
  });
});

describe("what the proxy's header actually does to req.ip", () => {
  /** One hop: HAProxy at 10.0.0.1 forwarding a phone on 10.0.0.42. */
  const forwarded = { url: "/ip", headers: { "x-forwarded-for": "10.0.0.42" }, remoteAddress: "10.0.0.1" };
  const serve = (trustProxy: ReturnType<typeof parseTrustProxy>) => {
    const app = Fastify({ trustProxy });
    app.get("/ip", (req) => ({ ip: req.ip, protocol: req.protocol }));
    return app;
  };

  it("ignores the header by default — the bug this setting fixes", async () => {
    const app = serve(parseTrustProxy(undefined));
    expect((await app.inject(forwarded)).json()).toMatchObject({ ip: "10.0.0.1" });
  });

  it("reports the client once the proxy's address is trusted", async () => {
    const app = serve(parseTrustProxy("10.0.0.1"));
    expect((await app.inject(forwarded)).json()).toMatchObject({ ip: "10.0.0.42" });
  });

  it("still ignores a forged header from an untrusted peer", async () => {
    // The whole reason this is not `trustProxy: true`: 10.0.0.99 is on the LAN
    // and can reach the port directly, but it is not the proxy, so its claim
    // about who it is — and about having spoken HTTPS — must not be believed.
    const app = serve(parseTrustProxy("10.0.0.1"));
    const response = await app.inject({
      url: "/ip",
      headers: { "x-forwarded-for": "8.8.8.8", "x-forwarded-proto": "https" },
      remoteAddress: "10.0.0.99",
    });
    expect(response.json()).toMatchObject({ ip: "10.0.0.99", protocol: "http" });
  });

  it("honours the proxy's x-forwarded-proto, which is what puts Secure on the cookie", async () => {
    const app = serve(parseTrustProxy("10.0.0.1"));
    const response = await app.inject({ ...forwarded, headers: { ...forwarded.headers, "x-forwarded-proto": "https" } });
    expect(response.json()).toMatchObject({ protocol: "https" });
  });
});
