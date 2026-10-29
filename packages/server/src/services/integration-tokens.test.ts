import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrationTokensPath, mintIntegrationToken } from "@dispatch/cli/core";
import { IntegrationTokenService } from "./integration-tokens.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function service(opts: { perMinute?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-token-svc-"));
  dirs.push(dir);
  let now = 1_000_000;
  const path = integrationTokensPath(dir);
  const svc = new IntegrationTokenService(path, () => now, opts.perMinute);
  return { svc, path, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe("IntegrationTokenService", () => {
  it("mints, authenticates, and reports the identity without the value", async () => {
    const { svc } = await service();
    const { token, summary } = await svc.mint(
      { name: "grok", scopes: ["chats:read", "tools:chat"], projectIds: ["p1"] },
      { authEpoch: 2 },
    );
    expect(token.startsWith("dsp_")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(token);
    const identity = await svc.authenticate(token, 2);
    expect(identity).toEqual({
      kind: "integration",
      tokenId: summary.id,
      name: "grok",
      scopes: ["chats:read", "tools:chat"],
      projectIds: ["p1"],
      trust: "external",
    });
  });

  it("carries trust onto the identity and changes it in place, with no remint", async () => {
    const { svc, path } = await service();
    const owned = await svc.mint({ name: "relay", scopes: ["chats:write"], trust: "owner" }, { authEpoch: 0 });
    expect(owned.summary.trust).toBe("owner");
    expect((await svc.authenticate(owned.token, 0))?.trust).toBe("owner");

    // Lowered: the very next request reads the new level, and the row goes
    // back to having NO trust field — identical to an ordinary token's.
    expect((await svc.setTrust(owned.summary.id, "external"))?.trust).toBe("external");
    expect((await svc.authenticate(owned.token, 0))?.trust).toBe("external");
    const { readIntegrationTokenFile } = await import("@dispatch/cli/core");
    expect((await readIntegrationTokenFile(path)).tokens[0]).not.toHaveProperty("trust");

    expect(await svc.setTrust("nope", "owner")).toBeNull();
  });

  it("refuses an unknown trust level instead of storing it", async () => {
    const { svc } = await service();
    await expect(
      svc.mint({ name: "x", scopes: ["chats:read"], trust: "admin" as never }, { authEpoch: 0 }),
    ).rejects.toThrow(/unknown trust level/);
  });

  it("reads a hand-edited, unrecognised trust as external, never higher", async () => {
    const { svc, path } = await service();
    const { token } = await svc.mint({ name: "x", scopes: ["chats:read"] }, { authEpoch: 0 });
    const core = await import("@dispatch/cli/core");
    const file = await core.readIntegrationTokenFile(path);
    (file.tokens[0] as { trust?: unknown }).trust = "OWNER";
    await core.writeIntegrationTokenFile(path, file);
    expect((await svc.authenticate(token, 0))?.trust).toBe("external");
  });

  it("rejects a wrong value, a non-token bearer, and a stale epoch", async () => {
    const { svc } = await service();
    const { token } = await svc.mint({ name: "a", scopes: ["chats:read"] }, { authEpoch: 1 });
    expect(await svc.authenticate(`${token}x`, 1)).toBeNull();
    expect(await svc.authenticate("not-a-token", 1)).toBeNull();
    expect(await svc.authenticate(undefined, 1)).toBeNull();
    // Minted under epoch 1; auth was turned off and on again since (epoch 2).
    expect(await svc.authenticate(token, 2)).toBeNull();
  });

  it("stops authenticating a revoked token and an expired one", async () => {
    const { svc, tick, now } = await service();
    const a = await svc.mint({ name: "a", scopes: ["chats:read"] }, { authEpoch: 0 });
    const b = await svc.mint(
      { name: "b", scopes: ["chats:read"], expiresAt: now() + 10_000 },
      { authEpoch: 0 },
    );
    expect(await svc.authenticate(a.token, 0)).not.toBeNull();
    expect(await svc.revoke(a.summary.id)).toBe(true);
    expect(await svc.authenticate(a.token, 0)).toBeNull();
    expect((await svc.list()).find((t) => t.id === a.summary.id)?.revokedAt).toBe(now());

    expect(await svc.authenticate(b.token, 0)).not.toBeNull();
    tick(10_001);
    expect(await svc.authenticate(b.token, 0)).toBeNull();
  });

  it("revokeAll stamps every live token and leaves earlier stamps alone", async () => {
    const { svc, tick } = await service();
    const a = await svc.mint({ name: "a", scopes: ["chats:read"] }, { authEpoch: 0 });
    await svc.mint({ name: "b", scopes: ["chats:read"] }, { authEpoch: 0 });
    await svc.revoke(a.summary.id);
    tick(5_000);
    expect(await svc.revokeAll()).toBe(1);
    const rows = await svc.list();
    expect(rows.every((r) => r.revokedAt !== undefined)).toBe(true);
    expect(rows.find((r) => r.name === "a")!.revokedAt).toBeLessThan(rows.find((r) => r.name === "b")!.revokedAt!);
  });

  it("sees a token the CLI minted underneath it", async () => {
    // The failure this guards: the server holding a stale in-memory list, so a
    // `dispatch token create` never authenticates until a restart.
    const { svc, path } = await service();
    await svc.mint({ name: "first", scopes: ["chats:read"] }, { authEpoch: 0 });
    expect((await svc.list()).map((r) => r.name)).toEqual(["first"]);
    const cli = await mintIntegrationToken(path, { name: "from-cli", scopes: ["projects:read"] }, { authEpoch: 0 });
    expect((await svc.authenticate(cli.token, 0))?.name).toBe("from-cli");
    expect((await svc.list()).map((r) => r.name)).toEqual(["first", "from-cli"]);
  });

  it("flushes lastUsedAt without clobbering a row minted since it loaded", async () => {
    const { svc, path, tick } = await service();
    const a = await svc.mint({ name: "a", scopes: ["chats:read"] }, { authEpoch: 0 });
    tick(2_000);
    await svc.authenticate(a.token, 0);
    // Minted by the CLI AFTER the server stamped `a` in memory.
    await mintIntegrationToken(path, { name: "late", scopes: ["chats:read"] }, { authEpoch: 0 });
    await svc.dispose();
    const rows = await svc.list();
    expect(rows.map((r) => r.name)).toEqual(["a", "late"]);
    expect(rows[0]!.lastUsedAt).toBe(1_002_000);
  });

  it("rate-limits per token with a Retry-After in whole seconds", async () => {
    const { svc, tick } = await service({ perMinute: 3 });
    expect(svc.checkRate("t1")).toBeNull();
    expect(svc.checkRate("t1")).toBeNull();
    expect(svc.checkRate("t1")).toBeNull();
    expect(svc.checkRate("t1")).toBe(60);
    // Another token has its own budget.
    expect(svc.checkRate("t2")).toBeNull();
    tick(30_000);
    expect(svc.checkRate("t1")).toBe(30);
    tick(30_001);
    expect(svc.checkRate("t1")).toBeNull();
  });
});
