import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsServerEvent } from "@cm/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { CheckpointService, CHECKPOINT_REF_NS } from "./checkpoint.js";

let repo: string;
let dataDir: string;
let store: Store;
let bus: EventBus;
let svc: CheckpointService;
let events: WsServerEvent[];

/** Run git in the temp repo with a deterministic identity. */
async function git(args: string[]): Promise<string> {
  const res = await execa("git", args, {
    cwd: repo,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stripFinalNewline: true,
  });
  return res.stdout;
}

const write = (rel: string, body: string) => writeFile(join(repo, rel), body);
const read = (rel: string) => readFile(join(repo, rel), "utf8");

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cm-cp-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "cm-cp-data-"));
  store = new Store(dataDir);
  await store.init();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  svc = new CheckpointService({ store, bus });

  await git(["init", "-b", "main"]);
  await write("a.txt", "v1");
  await mkdir(join(repo, "sub"), { recursive: true });
  await write("sub/keep.txt", "keep-v1");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("CheckpointService.snapshot", () => {
  it("writes a hidden ref + persists the mapping + publishes a bus event", async () => {
    const cp = await svc.snapshot({
      chatId: "chatA",
      messageId: "m1",
      worktreePath: repo,
      sessionMessageUuid: "u1",
    });

    expect(cp.ref).toBe(`${CHECKPOINT_REF_NS}/chatA/1`);
    expect(cp.sessionMessageUuid).toBe("u1");
    // Ref resolves to a real commit whose tree has a.txt == "v1".
    const show = await git(["show", `${cp.ref}:a.txt`]);
    expect(show).toBe("v1");

    // Persisted via Store.
    expect(await store.getCheckpoint("chatA", "m1")).toMatchObject({ ref: cp.ref });

    // Domain event published.
    const evt = events.find((e) => e.type === "checkpoint");
    expect(evt).toMatchObject({ type: "checkpoint", chatId: "chatA", messageId: "m1", ref: cp.ref });

    // Non-destructive: HEAD/branch untouched, working tree intact.
    expect((await git(["rev-parse", "--abbrev-ref", "HEAD"]))).toBe("main");
    expect(await read("a.txt")).toBe("v1");
  });

  it("allocates monotonically increasing ref indices per chat", async () => {
    await svc.snapshot({ chatId: "chatA", messageId: "m1", worktreePath: repo });
    await write("a.txt", "v2");
    await svc.snapshot({ chatId: "chatA", messageId: "m2", worktreePath: repo });
    const refs = await svc.listCheckpointRefs("chatA", repo);
    expect(refs).toEqual([
      `${CHECKPOINT_REF_NS}/chatA/1`,
      `${CHECKPOINT_REF_NS}/chatA/2`,
    ]);
  });
});

describe("CheckpointService.rollback", () => {
  it("restores modified/added/deleted files and returns the fork target", async () => {
    // Snapshot #1 at m1: a.txt=v1, sub/keep.txt=keep-v1.
    await svc.snapshot({ chatId: "chatA", messageId: "m1", worktreePath: repo, sessionMessageUuid: "u1" });

    // Mutate, then snapshot #2 (the "newer" checkpoint that must survive).
    await write("a.txt", "v2");
    await write("b.txt", "new-file"); // created after m1
    await svc.snapshot({ chatId: "chatA", messageId: "m2", worktreePath: repo, sessionMessageUuid: "u2" });

    // Diverge further from both snapshots.
    await write("a.txt", "v3");
    await rm(join(repo, "sub/keep.txt")); // delete a tracked file
    await write("c.txt", "another-new");

    // Roll back to m1.
    const res = await svc.rollback("chatA", "m1");

    // Fork target returned for the SessionBroker.
    expect(res.sessionMessageUuid).toBe("u1");
    expect(res.ref).toBe(`${CHECKPOINT_REF_NS}/chatA/1`);

    // Files restored EXACTLY to the m1 snapshot.
    expect(await read("a.txt")).toBe("v1"); // modification reverted
    expect(await read("sub/keep.txt")).toBe("keep-v1"); // deletion recreated
    expect(existsSync(join(repo, "b.txt"))).toBe(false); // post-m1 addition removed
    expect(existsSync(join(repo, "c.txt"))).toBe(false); // post-m1 addition removed
    expect(res.removed.sort()).toEqual(["b.txt", "c.txt"]);

    // Newer checkpoint ref still exists and still holds the v2 content.
    const refs = await svc.listCheckpointRefs("chatA", repo);
    expect(refs).toContain(`${CHECKPOINT_REF_NS}/chatA/2`);
    expect(await git(["show", `${CHECKPOINT_REF_NS}/chatA/2:a.txt`])).toBe("v2");

    // Working tree still on the same branch (no checkout/switch happened).
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("can roll forward to a later checkpoint (recreates a deleted file)", async () => {
    await svc.snapshot({ chatId: "chatB", messageId: "m1", worktreePath: repo });
    await write("a.txt", "v2");
    await write("b.txt", "new-file");
    await svc.snapshot({ chatId: "chatB", messageId: "m2", worktreePath: repo });

    // Go back to m1 (removes b.txt), then forward to m2 (restores it).
    await svc.rollback("chatB", "m1");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);

    await svc.rollback("chatB", "m2");
    expect(await read("a.txt")).toBe("v2");
    expect(await read("b.txt")).toBe("new-file");
  });

  it("throws when no checkpoint exists for the message", async () => {
    await expect(svc.rollback("chatA", "nope")).rejects.toThrow(/No checkpoint/);
  });
});
