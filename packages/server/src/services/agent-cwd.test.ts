import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCwdTracker,
  MAIN_THREAD,
  findWorktreeRoot,
  samePath,
  type AgentCwdTrackerDeps,
} from "./agent-cwd.js";

/* The two worktrees from the 2026-08-07 incident, as bare paths. */
const WT = "C:\\proj\\.claude\\worktrees";
const HOME = `${WT}\\dispatch-config-subapps`;
const OTHER = `${WT}\\agent-ae028addf8d56daf9`;
const ISO = `${WT}\\agent-a66bfb6c7bf2af198`;

/** A fake root resolver: longest declared root that contains the path wins. */
function roots(...known: string[]): AgentCwdTrackerDeps["resolveRoot"] {
  const sorted = [...known].sort((a, b) => b.length - a.length);
  return async (dir: string) => {
    const d = dir.replace(/\\/g, "/").toLowerCase();
    for (const r of sorted) {
      const k = r.replace(/\\/g, "/").toLowerCase();
      if (d === k || d.startsWith(`${k}/`)) return r;
    }
    return null;
  };
}

const edit = (thread: string, file: string, cwd = file) => ({
  thread,
  toolName: "Edit",
  cwd,
  input: { file_path: file },
});
const bash = (thread: string, cwd: string) => ({
  thread,
  toolName: "Bash",
  cwd,
  input: { command: "ls" },
});

describe("samePath", () => {
  it("ignores separator, case and a trailing slash", () => {
    expect(samePath("C:\\a\\b", "c:/a/b/")).toBe(true);
    expect(samePath("C:\\a\\b", "C:\\a\\bc")).toBe(false);
  });
});

describe("findWorktreeRoot", () => {
  it("stops at a `.git` DIRECTORY — the primary checkout", async () => {
    const base = await mkdtemp(join(tmpdir(), "dispatch-cwd-"));
    await mkdir(join(base, ".git"), { recursive: true });
    await mkdir(join(base, "packages", "server"), { recursive: true });
    expect(await findWorktreeRoot(join(base, "packages", "server"))).toBe(base);
  });

  it("stops at a `.git` FILE — a linked worktree, which is the case that matters", async () => {
    const base = await mkdtemp(join(tmpdir(), "dispatch-cwd-"));
    await mkdir(join(base, ".git"), { recursive: true });
    const wt = join(base, "wt", "feat-x");
    await mkdir(join(wt, "src"), { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${join(base, ".git", "worktrees", "feat-x")}`);
    expect(await findWorktreeRoot(join(wt, "src"))).toBe(wt);
  });

  it("returns null outside any repo rather than walking to the drive root", async () => {
    const base = await mkdtemp(join(tmpdir(), "dispatch-cwd-"));
    expect(await findWorktreeRoot(base)).toBeNull();
  });
});

describe("AgentCwdTracker — the main loop", () => {
  it("re-pins wherever it goes and is never refused", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    expect(await t.observe(edit(MAIN_THREAD, `${HOME}\\a.ts`))).toBeNull();
    // The parent deliberately EnterWorktree'd into another agent's tree to
    // commit its work — legitimate, and the house flow depends on it.
    expect(await t.observe(edit(MAIN_THREAD, `${OTHER}\\b.ts`))).toBeNull();
    const main = t.get(MAIN_THREAD)!;
    expect(main.pinned).toBe(OTHER);
    expect(main.displaced).toBe(false);
  });
});

describe("AgentCwdTracker — a subagent that gets moved", () => {
  it("allows every call in the worktree it claimed first", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    expect(await t.observe(edit("r1", `${HOME}\\a.ts`))).toBeNull();
    expect(await t.observe(edit("r1", `${HOME}\\b.ts`))).toBeNull();
    expect(t.get("r1")!.displaced).toBe(false);
  });

  it("refuses a write into a sibling worktree, naming both", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    const refusal = await t.observe(edit("r1", `${OTHER}\\package.json`));
    expect(refusal).not.toBeNull();
    expect(refusal!.pinned).toBe(HOME);
    expect(refusal!.attempted).toBe(OTHER);
    expect(refusal!.reason).toContain(HOME);
    expect(refusal!.reason).toContain(OTHER);
    expect(t.get("r1")!.strayWrites).toEqual([`${OTHER}\\package.json`]);
  });

  it("reports displacement once, on the first call from the wrong tree", async () => {
    const onDisplaced = vi.fn();
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER), onDisplaced });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    await t.observe(bash("r1", OTHER));
    await t.observe(bash("r1", OTHER));
    expect(onDisplaced).toHaveBeenCalledTimes(1);
    expect(onDisplaced.mock.calls[0]![0].pinned).toBe(HOME);
  });

  it("does NOT refuse a read-only tool in another worktree — reading around is normal", async () => {
    const onRefused = vi.fn();
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER), onRefused });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    expect(await t.observe(bash("r1", OTHER))).toBeNull();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("clears displacement when the thread finds its way home", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    await t.observe(bash("r1", OTHER));
    expect(t.get("r1")!.displaced).toBe(true);
    await t.observe(bash("r1", HOME));
    expect(t.get("r1")!.displaced).toBe(false);
  });

  it("catches a write whose RELATIVE path resolves out of the pin", async () => {
    // The exact trap: cwd moved, so "here" is no longer home.
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    const refusal = await t.observe({
      thread: "r1",
      toolName: "Write",
      cwd: OTHER,
      input: { file_path: "RUNNING.md" },
    });
    expect(refusal?.attempted).toBe(OTHER);
  });

  it("ignores a write to a path in no repo at all", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    expect(await t.observe(edit("r1", "C:\\Temp\\scratch.txt"))).toBeNull();
  });

  it("allows the call when the root lookup itself fails — never fail closed", async () => {
    const t = new AgentCwdTracker({
      resolveRoot: async () => {
        throw new Error("EPERM");
      },
    });
    expect(await t.observe(edit("r1", `${HOME}\\a.ts`))).toBeNull();
  });
});

describe("AgentCwdTracker — spawn inheritance", () => {
  /** Wire `parentOf` from a static child→parent map, as the broker does. */
  const withParents = (
    parents: Record<string, string>,
    deps: AgentCwdTrackerDeps = {},
  ) => new AgentCwdTracker({ parentOf: (t) => parents[t], ...deps });

  it("refuses the delegate a DISPLACED run spawned, whose first write is already wrong", async () => {
    // The incident's last hop: "Fix upgrade tool findings" was moved, gave up,
    // and handed its remaining edits to a fresh subagent that only ever saw the
    // wrong worktree. Its own first sighting must not become its pin.
    const t = withParents({ r2: "r1" }, { resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    await t.observe(bash("r1", OTHER)); // displaced by the parent's EnterWorktree
    const refusal = await t.observe(edit("r2", `${OTHER}\\RUNNING.md`));
    expect(refusal).not.toBeNull();
    expect(refusal!.pinned).toBe(HOME);
    expect(t.get("r2")!.pinned).toBe(HOME);
  });

  it("leaves an isolation:worktree subagent alone — its own tree is not a stray", async () => {
    // Its spawner is still on its pin, so the child claims the temp worktree the
    // runtime made for it. Flagging this was the false positive to avoid.
    const t = withParents({ r2: "r1" }, { resolveRoot: roots(HOME, ISO) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    expect(await t.observe(edit("r2", `${ISO}\\b.ts`))).toBeNull();
    expect(await t.observe(edit("r2", `${ISO}\\c.ts`))).toBeNull();
    expect(t.get("r2")!.pinned).toBe(ISO);
  });

  it("does not penalise a child for a parent that merely READ elsewhere and came back", async () => {
    const t = withParents({ r2: "r1" }, { resolveRoot: roots(HOME, OTHER, ISO) });
    await t.observe(edit("r1", `${HOME}\\a.ts`));
    await t.observe(bash("r1", OTHER));
    await t.observe(bash("r1", HOME)); // back home — no longer displaced
    expect(await t.observe(edit("r2", `${ISO}\\b.ts`))).toBeNull();
    expect(t.get("r2")!.pinned).toBe(ISO);
  });

  it("inherits through a subagent spawned by the MAIN loop after it moved", async () => {
    // Main is never displaced, so a run it spawns claims wherever main now is.
    const t = withParents({ r1: MAIN_THREAD }, { resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit(MAIN_THREAD, `${HOME}\\a.ts`));
    await t.observe(edit(MAIN_THREAD, `${OTHER}\\b.ts`));
    expect(await t.observe(edit("r1", `${OTHER}\\c.ts`))).toBeNull();
    expect(t.get("r1")!.pinned).toBe(OTHER);
  });
});

describe("AgentCwdTracker — bookkeeping", () => {
  it("resolves each directory's root at most once", async () => {
    const resolveRoot = vi.fn(roots(HOME)!);
    const t = new AgentCwdTracker({ resolveRoot });
    await t.observe(edit("r1", `${HOME}\\pkg\\a.ts`));
    await t.observe(edit("r1", `${HOME}\\pkg\\b.ts`));
    expect(resolveRoot).toHaveBeenCalledTimes(1);
  });

  it("lists every located thread", async () => {
    const t = new AgentCwdTracker({ resolveRoot: roots(HOME, OTHER) });
    await t.observe(edit(MAIN_THREAD, `${HOME}\\a.ts`));
    await t.observe(edit("r1", `${OTHER}\\b.ts`));
    expect(t.locations().map((l) => l.thread)).toEqual([MAIN_THREAD, "r1"]);
  });
});
