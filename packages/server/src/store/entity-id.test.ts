/**
 * The entity-id allowlist, at the Store layer.
 *
 * `routes/traversal.test.ts` proves the HTTP surface is closed; this proves the
 * chokepoint itself, including the shapes a containment check would have let
 * through and the ones that must keep working.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, isEntityId, InvalidEntityIdError } from "./index.js";
import type { Project, Chat } from "@dispatch/shared";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-eid-"));
  store = new Store(dir);
  await store.init();
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function chat(id: string): Chat {
  return {
    id,
    projectId: "p1",
    title: "Untitled",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: Date.now(),
  };
}
function project(id: string): Project {
  return {
    id,
    name: "P",
    repoPath: "C:/repo",
    worktreeRoot: "C:/wt",
    subApps: [],
    createdAt: Date.now(),
  };
}

describe("isEntityId", () => {
  it("accepts what we actually mint", () => {
    // nanoid's default alphabet is A-Za-z0-9_- , and hand-written slugs like the
    // seeded `auto` / `hivebreak` live in the same namespace.
    for (const id of ["V1StGXR8_Z5jdHi6B-myT", "auto", "hivebreak", "a", "A-_9", "x".repeat(64)]) {
      expect(isEntityId(id)).toBe(true);
    }
  });

  it("rejects the escapes", () => {
    for (const id of ["..", "../x", "..\\x", "/etc/passwd", "C:\\Windows", "\\\\srv\\share"]) {
      expect(isEntityId(id)).toBe(false);
    }
  });

  it("rejects what a CONTAINMENT check would have allowed", () => {
    // These all resolve to somewhere inside the root, so `resolve`+`relative`
    // says yes — which is exactly why the guard is an allowlist instead.
    expect(isEntityId("a/b")).toBe(false); // nested, invisible to listDir
    expect(isEntityId("a\\b")).toBe(false);
    expect(isEntityId("chat.json:evil")).toBe(false); // Windows alternate data stream
    expect(isEntityId("a ")).toBe(false); // trailing space — Windows rewrites it
    expect(isEntityId("a.")).toBe(false); // trailing dot — likewise
    expect(isEntityId("a.b")).toBe(false); // dots aren't in the alphabet at all
  });

  it("does NOT try to be a Windows reserved-name filter", () => {
    // `CON` / `PRN` / `AUX` are made only of allowlist characters, so they pass —
    // and deliberately so. They are not a traversal (Windows just refuses to
    // create them, EINVAL), and a reserved-name blocklist is its own tar pit of
    // extensions and casing. Asserted so nobody reads the allowlist as covering
    // more than it does.
    expect(isEntityId("CON")).toBe(true);
  });

  it("rejects the empty, the oversized and the non-string", () => {
    expect(isEntityId("")).toBe(false);
    expect(isEntityId("x".repeat(65))).toBe(false);
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(null)).toBe(false);
    expect(isEntityId(42)).toBe(false);
  });
});

describe("Store refuses an id that would leave its root", () => {
  it("deleteChat cannot remove a directory outside the store", async () => {
    // The severe one. Unguarded, `rm(chatDir(id), { recursive: true, force: true })`
    // took this whole tree; verified by running exactly this against the old code.
    const victim = join(dir, "..", `precious-${process.pid}`);
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep.txt"), "irreplaceable", "utf8");
    try {
      await expect(store.deleteChat(join("..", `precious-${process.pid}`))).rejects.toThrow(
        InvalidEntityIdError,
      );
      expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    } finally {
      await rm(victim, { recursive: true, force: true });
    }
  });

  it("saveChat / getChat / readMessages refuse one", async () => {
    await expect(store.saveChat(chat("../../evil"))).rejects.toThrow(InvalidEntityIdError);
    await expect(store.getChat("../../evil")).rejects.toThrow(InvalidEntityIdError);
    await expect(store.readMessages("../../evil")).rejects.toThrow(InvalidEntityIdError);
    await expect(store.patchChat("../../evil", { title: "x" })).rejects.toThrow(
      InvalidEntityIdError,
    );
  });

  it("the flat entity namespaces refuse one, and name the kind", async () => {
    await expect(store.saveProject(project("../../evil"))).rejects.toThrow(/invalid project id/);
    await expect(store.getProject("../../evil")).rejects.toThrow(InvalidEntityIdError);
    await expect(store.deleteProject("../../evil")).rejects.toThrow(InvalidEntityIdError);
    await expect(store.getAgent("../../evil")).rejects.toThrow(/invalid agent id/);
    await expect(store.getMode("../../evil")).rejects.toThrow(/invalid mode id/);
  });

  it("the error carries a 400 and no path", async () => {
    // The message is echoed to clients, so it must not confirm what is on disk.
    const err = await store.getChat("../../secret-dir/thing").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidEntityIdError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("invalid chat id");
    expect(err.message).not.toContain("secret-dir");
    expect(err.message).not.toContain(dir);
  });

  it("project memory paths are guarded too", () => {
    expect(() => store.projectMemoryDir("../../evil")).toThrow(InvalidEntityIdError);
    expect(() => store.projectMemoryStatsFile("../../evil")).toThrow(InvalidEntityIdError);
  });
});

describe("listing tolerates entries that aren't ids", () => {
  it("listChats skips a stray directory instead of throwing", async () => {
    await store.saveChat(chat("realchatid"));
    // An editor's temp dir, a half-finished restore, a .DS_Store — none of these
    // is a chat, and one of them must not take the whole sidebar down.
    for (const junk of [".tmp-restore", "not.an.id", "with space"]) {
      await mkdir(join(dir, "chats", junk), { recursive: true });
    }
    const chats = await store.listChats();
    expect(chats.map((c) => c.id)).toEqual(["realchatid"]);
  });

  it("listProjects skips a file whose name isn't an id", async () => {
    await store.saveProject(project("realproject"));
    await writeFile(join(dir, "projects", "not.an.id.json"), "{}", "utf8");
    const ids = (await store.listProjects()).map((p) => p.id);
    expect(ids).toEqual(["realproject"]);
  });
});
