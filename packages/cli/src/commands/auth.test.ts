import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { resetOwner } from "./auth.js";

describe("local owner recovery", () => {
  it("rehashes the owner password, clears TOTP, and revokes every session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-reset-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({ version: 1, users: [
      { username: "owner", owner: true, password: { hash: "old" }, totp: { secret: "secret" } },
      { username: "member", owner: false },
    ] }));
    await writeFile(join(dir, "auth-sessions.json"), JSON.stringify({ version: 1, sessions: [{}, { revokedAt: 1 }] }));

    const renames: string[] = [];
    await expect(resetOwner(dir, dir, "a sufficiently long new password", async (from, to) => {
      renames.push(String(to));
      await rename(from, to);
    })).resolves.toBe("owner");
    const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as {
      users: Array<{ owner: boolean; password?: { hash: string }; totp?: unknown; securityVersion?: number }>;
    };
    const sessions = JSON.parse(await readFile(join(dir, "auth-sessions.json"), "utf8")) as {
      sessions: Array<{ revokedAt?: number }>;
    };
    const owner = auth.users.find((user) => user.owner)!;
    expect(owner.totp).toBeUndefined();
    expect(owner.securityVersion).toBe(1);
    expect(owner.password?.hash).toMatch(/^\$argon2id\$/);
    await expect(verify(owner.password!.hash, "a sufficiently long new password")).resolves.toBe(true);
    expect(sessions.sessions.every((session) => typeof session.revokedAt === "number" && session.revokedAt > 1)).toBe(true);
    expect(renames.map((path) => path.split(/[\\/]/).at(-1))).toEqual(["auth-sessions.json", "auth.json"]);
  });

  it("rejects weak recovery passwords before touching disk", async () => {
    await expect(resetOwner("missing", "missing", "too short")).rejects.toThrow("12–256");
  });

  it("refuses recovery while the owning Dispatch process is live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-live-"));
    await writeFile(join(dir, "auth-recovery.lock"), JSON.stringify({ pid: process.pid }));
    await expect(resetOwner(dir, dir, "a sufficiently long new password")).rejects.toThrow("still running");
  });
});
