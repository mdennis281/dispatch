import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsService, plainKeyProtector, type SecretKey } from "./secrets.js";

let dir: string;
const svc = () => new SecretsService({ configDir: dir, protector: plainKeyProtector });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-secrets-"));
});

describe("SecretsService", () => {
  it("round-trips a value through encryption and never writes it in the clear", async () => {
    const s = svc();
    await s.start();
    await s.set({ name: "API_KEY", scope: "global" }, "sk-very-secret");
    expect(s.resolve(undefined, "API_KEY")).toBe("sk-very-secret");
    const onDisk = await readFile(join(dir, "secrets.json"), "utf8");
    expect(onDisk).not.toContain("sk-very-secret");

    const fresh = svc();
    await fresh.start();
    expect(fresh.resolve("p1", "API_KEY")).toBe("sk-very-secret");
  });

  it("prefers a project's own secret over the global one", async () => {
    const s = svc();
    await s.set({ name: "TOKEN", scope: "global" }, "global");
    await s.set({ name: "TOKEN", scope: "project", projectId: "p1" }, "mine");
    expect(s.resolve("p1", "TOKEN")).toBe("mine");
    expect(s.resolve("p2", "TOKEN")).toBe("global");
    expect((await s.list("p2")).map((x) => x.scope)).toEqual(["global"]);
  });

  it("lists names without values", async () => {
    const s = svc();
    await s.set({ name: "A", scope: "global" }, "value-a");
    const listed = await s.list();
    expect(JSON.stringify(listed)).not.toContain("value-a");
    expect(listed[0]).toMatchObject({ name: "A", scope: "global" });
  });

  it("deletes, reports whether anything went, and doesn't announce its own writes", async () => {
    const s = svc();
    const seen: SecretKey[][] = [];
    s.onExternalChange((c) => void seen.push(c));
    await s.set({ name: "A", scope: "global" }, "x");
    expect(await s.delete({ name: "A", scope: "global" })).toBe(true);
    expect(await s.delete({ name: "A", scope: "global" })).toBe(false);
    expect(s.resolve(undefined, "A")).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("refuses a project secret with no project and a malformed name", async () => {
    const s = svc();
    await expect(s.set({ name: "A", scope: "project" }, "x")).rejects.toThrow(/projectId/);
    await expect(s.set({ name: "not-valid", scope: "global" }, "x")).rejects.toThrow();
  });

  it("sees a save made by another instance sharing the config dir", async () => {
    const a = svc();
    const b = svc();
    await a.start();
    await b.start();
    const seen: SecretKey[][] = [];
    b.onExternalChange((c) => void seen.push(c));
    await a.set({ name: "SHARED", scope: "global" }, "from-a");
    // mtime granularity: make sure b's cached stamp can't equal the new one.
    await new Promise((r) => setTimeout(r, 20));
    await b.list();
    expect(b.resolve(undefined, "SHARED")).toBe("from-a");
    expect(seen.flat().map((k) => k.name)).toContain("SHARED");
    // …and b's own save keeps a's entry rather than overwriting the file from its cache.
    await b.set({ name: "OTHER", scope: "global" }, "from-b");
    const c = svc();
    await c.start();
    expect(c.resolve(undefined, "SHARED")).toBe("from-a");
  });

  it("refuses a ciphertext moved onto a different name", async () => {
    const s = svc();
    await s.set({ name: "REAL", scope: "global" }, "x");
    const path = join(dir, "secrets.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    file.entries[0].name = "STOLEN";
    await writeFile(path, JSON.stringify(file));
    const fresh = svc();
    await fresh.start();
    expect(fresh.resolve(undefined, "STOLEN")).toBeUndefined();
  });
});
