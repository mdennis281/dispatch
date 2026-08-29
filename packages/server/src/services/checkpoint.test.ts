import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsServerEvent } from "@dispatch/shared";
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
  store.close();
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

describe("checkpoint ref lifecycle", () => {
  /** Every checkpoint ref in the temp repo, whatever chat owns it. */
  async function allRefs(): Promise<string[]> {
    const out = await git(["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_NS]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  it("forget() deletes a chat's refs so git can finally reclaim the objects", async () => {
    // The 81 MiB: deleting a chat dropped its rows and left the refs behind.
    // They are unreachable from any branch but still REFERENCED, so `git gc`
    // packs the commits and trees they pin instead of pruning them, and nothing
    // ever reports them again.
    for (const m of ["m1", "m2", "m3"]) {
      await write("a.txt", `v-${m}`);
      await svc.snapshot({ chatId: "doomed", messageId: m, worktreePath: repo });
    }
    await svc.snapshot({ chatId: "keeper", messageId: "k1", worktreePath: repo });
    expect(await allRefs()).toHaveLength(4);

    const deleted = await svc.forget("doomed");

    expect(deleted).toHaveLength(3);
    // The other chat's history is untouched — the namespace is per chat.
    expect(await allRefs()).toEqual([`${CHECKPOINT_REF_NS}/keeper/1`]);
  });

  it("forget() also collects a ref whose store row never landed", async () => {
    // `nextIndex` allocates and `update-ref` writes before `saveCheckpoint`, so a
    // crash between them leaves a ref no row points at. Driving deletion purely
    // off the rows would strand exactly the orphans nothing else collects.
    await svc.snapshot({ chatId: "crashy", messageId: "m1", worktreePath: repo });
    await git(["update-ref", `${CHECKPOINT_REF_NS}/crashy/99`, "HEAD"]);
    expect(await allRefs()).toHaveLength(2);

    await svc.forget("crashy", repo);

    expect(await allRefs()).toEqual([]);
  });

  it("forget() reclaims refs when EVERY recorded worktree has been reaped", async () => {
    // The production shape, and the one the first version of this PR got wrong.
    // WorktreeReaper removes the worktree of a chat whose branch has landed and
    // leaves the chat and its rows behind, so a chat deleted a while after its
    // work merged names only dead directories. Removing a worktree never touches
    // refs, and they live in the primary repo's SHARED ref store — so the refs
    // are still there to reclaim, and only a live fallback can reach them.
    // Without one this found nothing and the 81 MiB stayed put.
    const parked = await mkdtemp(join(tmpdir(), "cm-cp-reaped-"));
    const wt = join(parked, "wt");
    await git(["worktree", "add", wt, "-b", "landed"]);
    await svc.snapshot({ chatId: "reapedChat", messageId: "m1", worktreePath: wt });
    await svc.snapshot({ chatId: "reapedChat", messageId: "m2", worktreePath: wt });
    await git(["worktree", "remove", "--force", wt]);
    expect(existsSync(wt)).toBe(false);
    // The refs outlived the directory, which is the whole problem.
    expect(await allRefs()).toHaveLength(2);

    // `repo` stands in for the project's primary checkout, as the route passes it.
    const deleted = await svc.forget("reapedChat", repo);

    expect(deleted).toHaveLength(2);
    expect(await allRefs()).toEqual([]);
    await rm(parked, { recursive: true, force: true });
  });

  it("caps refs whose recorded worktree is gone, instead of stranding them", async () => {
    // A chat's rows do not all name the same directory. `cp.worktreePath ||
    // fallback` only falls back on an EMPTY path, so a retired row pointing at a
    // removed worktree used to drop the row and leave the ref — the cap bounding
    // rows but not refs, which is the opposite of what it is for.
    const capped = new CheckpointService({ store, bus, maxPerChat: 1 });
    const parked = await mkdtemp(join(tmpdir(), "cm-cp-old-"));
    const oldWt = join(parked, "wt");
    await git(["worktree", "add", oldWt, "-b", "old-branch"]);
    await capped.snapshot({ chatId: "mover", messageId: "m1", worktreePath: oldWt });
    await git(["worktree", "remove", "--force", oldWt]);
    expect(existsSync(oldWt)).toBe(false);

    // The chat moves on and snapshots in a live checkout, crossing the cap.
    await write("a.txt", "moved");
    await capped.snapshot({ chatId: "mover", messageId: "m2", worktreePath: repo });

    // m1's row is retired AND its ref is gone — not stranded in a dead worktree.
    expect((await store.getCheckpoints("mover")).map((c) => c.messageId)).toEqual(["m2"]);
    expect(await allRefs()).toEqual([`${CHECKPOINT_REF_NS}/mover/2`]);
    await rm(parked, { recursive: true, force: true });
  });

  it("forget() survives a worktree that is no longer on disk", async () => {
    // Worktrees get reaped. A chat whose recorded path is gone must still delete
    // its chat record rather than throwing out of the DELETE route.
    await svc.snapshot({ chatId: "moved", messageId: "m1", worktreePath: repo });
    const gone = join(tmpdir(), "cm-cp-not-here-at-all");
    await store.saveCheckpoint({
      messageId: "m2",
      chatId: "moved",
      ref: `${CHECKPOINT_REF_NS}/moved/2`,
      worktreePath: gone,
      createdAt: Date.now(),
    });

    // The live repo is still reachable via the fallback, so the real ref goes.
    await expect(svc.forget("moved", repo)).resolves.toBeDefined();
    expect(await allRefs()).toEqual([]);
  });

  it("caps refs per chat, dropping the oldest ref AND its row together", async () => {
    // Nothing bounded these: one repo carried 4,057 refs across 124 chats.
    const capped = new CheckpointService({ store, bus, maxPerChat: 3 });
    for (const m of ["m1", "m2", "m3", "m4", "m5"]) {
      await write("a.txt", `v-${m}`);
      await capped.snapshot({ chatId: "busy", messageId: m, worktreePath: repo });
    }

    expect(await allRefs()).toEqual([
      `${CHECKPOINT_REF_NS}/busy/3`,
      `${CHECKPOINT_REF_NS}/busy/4`,
      `${CHECKPOINT_REF_NS}/busy/5`,
    ]);
    // The rows track the refs exactly — a surviving row whose ref was deleted
    // would render a rollback button that cannot work.
    const rows = await store.getCheckpoints("busy");
    expect(rows.map((c) => c.messageId)).toEqual(["m3", "m4", "m5"]);
  });

  it("keeps the checkpoint it just took, even at the smallest cap", async () => {
    // The window must slide by one, not evict the newest row as it is written.
    const capped = new CheckpointService({ store, bus, maxPerChat: 1 });
    await write("a.txt", "first");
    await capped.snapshot({ chatId: "tight", messageId: "m1", worktreePath: repo });
    await write("a.txt", "second");
    const latest = await capped.snapshot({
      chatId: "tight",
      messageId: "m2",
      worktreePath: repo,
    });

    const rows = await store.getCheckpoints("tight");
    expect(rows.map((c) => c.messageId)).toEqual(["m2"]);
    // And it is still restorable — the ref the newest row names really exists.
    expect(await allRefs()).toEqual([latest.ref]);
  });

  it("rolls back to a capped-survivor ref, proving the kept ones still work", async () => {
    const capped = new CheckpointService({ store, bus, maxPerChat: 2 });
    await write("a.txt", "one");
    await capped.snapshot({ chatId: "roll", messageId: "m1", worktreePath: repo });
    await write("a.txt", "two");
    await capped.snapshot({ chatId: "roll", messageId: "m2", worktreePath: repo });
    await write("a.txt", "three");
    await capped.snapshot({ chatId: "roll", messageId: "m3", worktreePath: repo });

    await write("a.txt", "dirty");
    await capped.rollback("roll", "m2");

    expect(await read("a.txt")).toBe("two");
  });
});
