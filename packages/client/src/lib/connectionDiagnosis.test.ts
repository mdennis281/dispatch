import { describe, expect, it } from "vitest";
import {
  classifyReach,
  describeClose,
  diagnose,
  isStaleBundle,
  STALE_FRAME_LIMIT,
  type Check,
  type DiagnosisInput,
} from "./connectionDiagnosis.js";

/** Healthy-everything baseline; each test perturbs exactly the axis it's about. */
function input(over: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    reach: "remote",
    host: "dispatch.example.com",
    online: true,
    state: "closed",
    probe: { kind: "ok", status: 200, at: 0 },
    clientVersion: "2026.08.20.00001",
    badFrames: 0,
    badFrameTypes: [],
    ...over,
  };
}

function check(checks: Check[], id: Check["id"]): Check {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

describe("classifyReach", () => {
  it("treats loopback names and addresses as local", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "app.localhost"]) {
      expect(classifyReach(host)).toBe("loopback");
    }
  });

  it("recognises the private ranges and mDNS", () => {
    for (const host of ["10.0.0.90", "192.168.1.5", "172.16.0.1", "172.31.255.254", "nas.local"]) {
      expect(classifyReach(host)).toBe("lan");
    }
  });

  it("does not swallow public space next to the 172.16/12 block", () => {
    // The lazy /^172\./ would call both of these private. 172.15 and 172.32 are
    // routable, and a wrong answer here sends someone to check their wifi over a
    // reverse proxy that's down.
    expect(classifyReach("172.15.0.1")).toBe("remote");
    expect(classifyReach("172.32.0.1")).toBe("remote");
  });

  it("is case-insensitive", () => {
    expect(classifyReach("NAS.LOCAL")).toBe("lan");
  });

  it("treats anything else as remote", () => {
    expect(classifyReach("dispatch.example.com")).toBe("remote");
    expect(classifyReach("9.9.9.9")).toBe("remote");
  });
});

describe("isStaleBundle", () => {
  it("is false when the server has no version to compare against", () => {
    // A source checkout has no release manifest. Guessing would put a permanent
    // "reload me" screen in front of every developer.
    expect(isStaleBundle("2026.08.20.00001", undefined)).toBe(false);
  });

  it("is false when they match and true when they don't", () => {
    expect(isStaleBundle("2026.08.20.00001", "2026.08.20.00001")).toBe(false);
    expect(isStaleBundle("2026.08.20.00001", "2026.08.21.00002")).toBe(true);
  });
});

describe("describeClose", () => {
  it("names the codes that carry a cause", () => {
    expect(describeClose({ code: 1006, reason: "", wasClean: false, at: 0 })).toContain("1006");
    expect(describeClose({ code: 4401, reason: "session revoked", wasClean: true, at: 0 }))
      .toBe("session revoked");
    expect(describeClose({ code: 1012, reason: "", wasClean: true, at: 0 })).toBe("server restarting");
  });

  it("falls back to the raw code for anything unrecognised", () => {
    expect(describeClose({ code: 4999, reason: "", wasClean: false, at: 0 })).toBe("closed (4999)");
    expect(describeClose({ code: 4999, reason: "nope", wasClean: false, at: 0 })).toBe("nope (4999)");
  });

  it("says so when there has been no connection at all", () => {
    expect(describeClose(undefined)).toBe("no connection yet");
  });
});

describe("diagnose — network", () => {
  it("reports being offline when the server is somewhere else", () => {
    const d = diagnose(input({ online: false }));
    expect(d.headline).toBe("This device is offline");
    expect(check(d.checks, "network").state).toBe("fail");
  });

  it("does not blame the network for a server on this machine", () => {
    // A dead uplink cannot stop a loopback connection, and saying "check your
    // wifi" over a process that isn't running is the wrong instruction.
    const d = diagnose(input({ online: false, reach: "loopback", probe: { kind: "unreachable", at: 0 } }));
    expect(d.headline).toBe("Dispatch isn't running");
    expect(check(d.checks, "network").state).toBe("skip");
  });
});

describe("diagnose — server", () => {
  it("tells a dead loopback server from an unreachable remote one", () => {
    const local = diagnose(input({ reach: "loopback", host: "localhost", probe: { kind: "unreachable", at: 0 } }));
    expect(local.headline).toBe("Dispatch isn't running");
    expect(local.hint).toContain("pnpm app");

    const remote = diagnose(input({ probe: { kind: "unreachable", at: 0 } }));
    expect(remote.headline).toBe("Can't reach dispatch.example.com");
    expect(remote.hint).toContain("tunnel");
  });

  it("separates a live proxy with a dead backend from nothing answering", () => {
    const d = diagnose(input({ probe: { kind: "gateway", status: 502, at: 0 } }));
    expect(d.headline).toBe("The proxy is up, Dispatch isn't");
    expect(d.detail).toContain("502");
    // The distinction that matters: DNS and the tunnel are fine, so the fix is
    // on the host, not the network.
    expect(d.hint).toContain("Dispatch process");
  });

  it("calls out a body that isn't Dispatch's", () => {
    const d = diagnose(input({ probe: { kind: "not-json", status: 200, at: 0 } }));
    expect(d.headline).toContain("Something else is answering");
    expect(d.hint).toContain("wifi");
  });

  it("blames the edge for a 401 on a route Dispatch never authenticates", () => {
    const d = diagnose(input({ probe: { kind: "unauthorized", status: 403, at: 0 } }));
    expect(d.headline).toBe("Blocked before reaching Dispatch");
    expect(d.detail).toContain("403");
  });

  it("passes a degraded server's own problems through verbatim", () => {
    const d = diagnose(
      input({
        probe: { kind: "degraded", status: 503, problems: ["client dist missing"], spa: false, at: 0 },
      }),
    );
    expect(d.headline).toBe("Dispatch is running, but unhealthy");
    expect(d.detail).toBe("client dist missing");
    expect(d.hint).toContain("web assets are missing");
  });

  it("does not report the socket and protocol as separate failures of a dead server", () => {
    // Every downstream check fails when the server is gone. Listing all three
    // buries the one that can be acted on.
    const d = diagnose(input({ probe: { kind: "unreachable", at: 0 } }));
    expect(check(d.checks, "socket").state).toBe("skip");
    expect(check(d.checks, "protocol").state).toBe("skip");
    expect(d.checks.filter((c) => c.state === "fail")).toHaveLength(1);
  });
});

describe("diagnose — socket", () => {
  it("names the proxy when HTTP works and the upgrade doesn't", () => {
    const d = diagnose(input({ lastClose: { code: 1006, reason: "", wasClean: false, at: 0 } }));
    expect(d.headline).toBe("The live connection won't open");
    expect(d.hint).toContain("Upgrade");
    expect(check(d.checks, "server").state).toBe("ok");
    expect(check(d.checks, "socket").state).toBe("fail");
  });

  it("keeps the proxy advice off a loopback connection", () => {
    const d = diagnose(
      input({
        reach: "loopback",
        host: "localhost",
        lastClose: { code: 1006, reason: "", wasClean: false, at: 0 },
      }),
    );
    expect(d.hint).not.toContain("proxy");
  });

  it("routes an expired session to signing in rather than to retrying", () => {
    const d = diagnose(
      input({ lastClose: { code: 4401, reason: "session revoked", wasClean: true, at: 0 } }),
    );
    expect(d.headline).toBe("Session no longer valid");
    expect(d.action).toBe("sign-in");
  });

  it("uses the auth probe when the close code cannot say (the 401 the browser hides)", () => {
    const d = diagnose(input({ probe: { kind: "ok", status: 200, needsLogin: true, at: 0 } }));
    expect(d.headline).toBe("Sign in again");
    expect(d.action).toBe("sign-in");
  });

  it("reports an open socket that never handshook", () => {
    const d = diagnose(input({ state: "open" }));
    expect(d.headline).toBe("Connected, but the server hasn't said hello");
    expect(check(d.checks, "socket").state).toBe("warn");
  });
});

describe("diagnose — protocol", () => {
  it("names a stale bundle and offers the reload that fixes it", () => {
    const d = diagnose(
      input({ state: "open", serverVersion: "2026.08.21.00002" }),
    );
    expect(d.headline).toBe("This tab is running an old build");
    expect(d.detail).toContain("2026.08.20.00001");
    expect(d.detail).toContain("2026.08.21.00002");
    expect(d.action).toBe("reload");
    expect(check(d.checks, "protocol").state).toBe("fail");
  });

  it("outranks every other verdict, because it is the one that looks healthy", () => {
    // Server unreachable AND stale: the staleness is what a reload fixes, and a
    // "start the server" instruction would send the user somewhere useless.
    const d = diagnose(
      input({ probe: { kind: "unreachable", at: 0 }, serverVersion: "2026.08.21.00002" }),
    );
    expect(d.headline).toBe("This tab is running an old build");
  });

  it("tolerates a stray bad frame but not a pattern of them", () => {
    const under = diagnose(input({ state: "open", badFrames: STALE_FRAME_LIMIT - 1 }));
    expect(under.headline).toBe("Connected, but the server hasn't said hello");
    expect(check(under.checks, "protocol").state).toBe("ok");

    const over = diagnose(
      input({ state: "open", badFrames: STALE_FRAME_LIMIT, badFrameTypes: ["chat-status"] }),
    );
    expect(over.headline).toContain("protocol this build doesn't know");
    expect(over.detail).toContain("chat-status");
    expect(over.action).toBe("reload");
  });
});

describe("diagnose — in-flight states", () => {
  it("says it is still checking before the first probe answers", () => {
    const d = diagnose(input({ probe: undefined, state: "connecting" }));
    expect(d.headline).toBe("Checking the connection");
    expect(check(d.checks, "server").state).toBe("pending");
  });

  it("reports a plain reconnect without alarm when the server is fine", () => {
    const d = diagnose(input({ state: "reconnecting" }));
    expect(d.headline).toBe("Reconnecting");
    expect(d.checks.some((c) => c.state === "fail")).toBe(false);
  });
});
