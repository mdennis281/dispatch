import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INTEGRATION_TOKEN_PREFIX } from "@dispatch/shared";
import {
  generateIntegrationToken,
  hashIntegrationToken,
  integrationTokensPath,
  listIntegrationTokens,
  mintIntegrationToken,
  parseExpiry,
  revokeIntegrationToken,
  validateIntegrationTokenRequest,
  withIntegrationTokenLock,
} from "./integration-tokens.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-tokens-"));
  dirs.push(dir);
  return integrationTokensPath(dir);
}

describe("token format", () => {
  it("is dsp_ plus 32 random bytes as base64url", () => {
    const token = generateIntegrationToken();
    expect(token.startsWith(INTEGRATION_TOKEN_PREFIX)).toBe(true);
    const body = token.slice(INTEGRATION_TOKEN_PREFIX.length);
    expect(Buffer.from(body, "base64url")).toHaveLength(32);
    expect(body).not.toMatch(/[+/=]/);
    expect(generateIntegrationToken()).not.toBe(token);
  });

  it("hashes the whole token, prefix included", () => {
    const token = generateIntegrationToken();
    expect(hashIntegrationToken(token)).not.toBe(hashIntegrationToken(token.slice(4)));
  });
});

describe("minting", () => {
  it("stores only the hash and returns the value exactly once", async () => {
    const path = await tempFile();
    const { token, row } = await mintIntegrationToken(
      path,
      { name: "grok", scopes: ["chats:read", "tools:chat"] },
      { authEpoch: 3 },
    );
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(row.hash);
    expect(row.hash).toBe(hashIntegrationToken(token));
    expect(row.authEpoch).toBe(3);
    expect(row.scopes).toEqual(["chats:read", "tools:chat"]);
  });

  it("refuses an unknown scope rather than dropping it", () => {
    expect(() =>
      validateIntegrationTokenRequest({ name: "x", scopes: ["chats:read", "chats:admin"] }, 0),
    ).toThrow(/chats:admin/);
  });

  it("refuses an empty name, no scopes, and a past expiry", () => {
    expect(() => validateIntegrationTokenRequest({ name: " ", scopes: ["chats:read"] }, 0)).toThrow(/name/);
    expect(() => validateIntegrationTokenRequest({ name: "x", scopes: [] }, 0)).toThrow(/scope/);
    expect(() =>
      validateIntegrationTokenRequest({ name: "x", scopes: ["chats:read"], expiresAt: 5 }, 10),
    ).toThrow(/future/);
  });

  it("canonicalises and dedups scopes and project ids", () => {
    const fields = validateIntegrationTokenRequest(
      { name: "x", scopes: ["tools:chat", "chats:read", "chats:read"], projectIds: ["p1", " p1 ", "p2"] },
      0,
    );
    expect(fields.scopes).toEqual(["chats:read", "tools:chat"]);
    expect(fields.projectIds).toEqual(["p1", "p2"]);
  });
});

describe("listing and revoking", () => {
  it("keeps a revoked row with its timestamp instead of deleting it", async () => {
    const path = await tempFile();
    const a = await mintIntegrationToken(path, { name: "a", scopes: ["chats:read"] }, { authEpoch: 0 });
    const b = await mintIntegrationToken(path, { name: "b", scopes: ["chats:read"] }, { authEpoch: 0 });
    expect(await revokeIntegrationToken(path, a.row.id, 1_000)).toBe(true);
    expect(await revokeIntegrationToken(path, "nope")).toBe(false);
    const rows = await listIntegrationTokens(path);
    expect(rows.map((r) => [r.name, r.revokedAt])).toEqual([
      ["a", 1_000],
      ["b", undefined],
    ]);
    // A second revoke is idempotent: the first timestamp stands.
    await revokeIntegrationToken(path, a.row.id, 2_000);
    expect((await listIntegrationTokens(path))[0]!.revokedAt).toBe(1_000);
    expect(b.row.revokedAt).toBeUndefined();
  });

  it("serialises concurrent mints so none is lost", async () => {
    // The failure this guards: two writers reading the same file, each
    // appending its own row, the second rename clobbering the first.
    const path = await tempFile();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mintIntegrationToken(path, { name: `t${i}`, scopes: ["chats:read"] }, { authEpoch: 0 }),
      ),
    );
    expect((await listIntegrationTokens(path)).map((r) => r.name).sort()).toEqual([
      "t0", "t1", "t2", "t3", "t4", "t5",
    ]);
  });

  it("releases the lock after a task throws", async () => {
    const path = await tempFile();
    await expect(withIntegrationTokenLock(path, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withIntegrationTokenLock(path, async () => "again")).resolves.toBe("again");
  });
});

describe("parseExpiry", () => {
  it("reads durations and ISO dates", () => {
    expect(parseExpiry("30d", 0)).toBe(30 * 86_400_000);
    expect(parseExpiry("12h", 0)).toBe(12 * 3_600_000);
    expect(parseExpiry("90m", 0)).toBe(90 * 60_000);
    expect(parseExpiry("2030-01-01T00:00:00Z")).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(() => parseExpiry("soon")).toThrow(/expiry/);
  });
});
