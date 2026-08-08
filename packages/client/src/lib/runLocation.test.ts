import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@dispatch/shared";
import { collectWorkRoots, deriveRunLocations, rootLabel } from "./runLocation.js";
import { deriveSubagentRuns } from "./subagentRuns.js";

const CHAT = "c1";
let seq = 0;
const id = () => `m${++seq}`;

const WT = "C:\\Users\\m\\proj\\.claude\\worktrees";
const HOME = `${WT}\\dispatch-config-subapps`;
const OTHER = `${WT}\\agent-ae028addf8d56daf9`;

function tool(
  name: string,
  input: Record<string, unknown>,
  opts: { parent?: string; ts?: number; toolUseId?: string } = {},
): ChatMessage {
  return {
    kind: "tool_use",
    id: id(),
    chatId: CHAT,
    ts: opts.ts ?? ++seq,
    toolUseId: opts.toolUseId ?? id(),
    name,
    input,
    ...(opts.parent ? { parentToolUseId: opts.parent } : {}),
  };
}

const edit = (file: string, parent?: string) => tool("Edit", { file_path: file }, { parent });
const write = (file: string, parent?: string) => tool("Write", { file_path: file }, { parent });
const enter = (path: string, parent?: string) => tool("EnterWorktree", { path }, { parent });
const bash = (command: string, parent?: string) => tool("Bash", { command }, { parent });

function agent(toolUseId: string, opts: { parent?: string; ts?: number } = {}): ChatMessage {
  return {
    kind: "tool_use",
    id: id(),
    chatId: CHAT,
    ts: opts.ts ?? ++seq,
    toolUseId,
    name: "Agent",
    input: { subagent_type: "general-purpose", description: "do a thing" },
    ...(opts.parent ? { parentToolUseId: opts.parent } : {}),
  };
}

describe("collectWorkRoots", () => {
  it("takes every EnterWorktree target plus the caller's known roots", () => {
    const roots = collectWorkRoots([enter(OTHER)], [HOME]);
    expect(roots).toContain(OTHER);
    expect(roots).toContain(HOME);
  });

  it("sorts longest-first so a nested worktree beats the checkout that holds it", () => {
    const repo = "C:\\Users\\m\\proj";
    const roots = collectWorkRoots([], [repo, HOME]);
    expect(roots[0]).toBe(HOME);
  });

  it("ignores a relative EnterWorktree path rather than inventing a base for it", () => {
    expect(collectWorkRoots([enter("../elsewhere")])).toEqual([]);
  });

  it("dedupes roots that differ only by separator or case", () => {
    const roots = collectWorkRoots([enter(HOME.replace(/\\/g, "/"))], [HOME]);
    expect(roots).toHaveLength(1);
  });

  it("recovers a runtime-made isolation worktree from the container its siblings prove", () => {
    // An `isolation: "worktree"` subagent gets a worktree with no EnterWorktree
    // row to name it. Two known roots establish `WT` as a worktree container, so
    // a third path under it yields a third root.
    const iso = `${WT}\\agent-a66bfb6c7bf2af198`;
    const roots = collectWorkRoots([edit(`${iso}\\packages\\client\\src\\a.ts`)], [HOME, OTHER]);
    expect(roots).toContain(iso);
  });

  it("claims only the direct child of the container, never a deeper directory", () => {
    const roots = collectWorkRoots([edit(`${WT}\\wt-x\\packages\\server\\b.ts`)], [HOME, OTHER]);
    expect(roots).toContain(`${WT}\\wt-x`);
    expect(roots).not.toContain(`${WT}\\wt-x\\packages`);
  });

  it("will not treat a checkout's parent as a container off a single known root", () => {
    // `C:\proj` holds one known root, so its siblings are other repositories,
    // not this project's tasks — expanding there would invent roots.
    const roots = collectWorkRoots([edit("C:\\proj\\other-repo\\a.ts")], ["C:\\proj\\my-repo"]);
    expect(roots).toEqual(["C:\\proj\\my-repo"]);
  });
});

describe("rootLabel", () => {
  it("is the worktree directory name, on either separator", () => {
    expect(rootLabel(HOME)).toBe("dispatch-config-subapps");
    expect(rootLabel("/home/m/proj/.worktrees/feat-x/")).toBe("feat-x");
  });
});

describe("deriveRunLocations — the ordinary case", () => {
  const roots = [HOME, OTHER];

  it("reports the root a run works in and every file it wrote", () => {
    const locs = deriveRunLocations(
      [{ id: "r1", rows: [edit(`${HOME}\\a.ts`), write(`${HOME}\\b.ts`)] }],
      roots,
    );
    const loc = locs.get("r1")!;
    expect(loc.home).toBe(HOME);
    expect(loc.current).toBe(HOME);
    expect(loc.files).toEqual([`${HOME}\\a.ts`, `${HOME}\\b.ts`]);
    expect(loc.strayRoots).toEqual([]);
  });

  it("is empty — not guessed — for a run whose rows named no path", () => {
    const locs = deriveRunLocations([{ id: "r1", rows: [bash("pnpm test")] }], roots);
    expect(locs.get("r1")).toEqual({
      roots: [],
      files: [],
      strayRoots: [],
      strayFiles: [],
    });
  });

  it("learns the working directory from a leading absolute `cd`", () => {
    const locs = deriveRunLocations([{ id: "r1", rows: [bash(`cd "${HOME}" && ls`)] }], roots);
    expect(locs.get("r1")!.home).toBe(HOME);
  });

  it("ignores a `cd` that is relative or buried mid-command", () => {
    const locs = deriveRunLocations(
      [{ id: "r1", rows: [bash("ls && cd ../elsewhere"), bash("cd packages")] }],
      roots,
    );
    expect(locs.get("r1")!.home).toBeUndefined();
  });

  it("attributes a path under no known root to nothing at all", () => {
    const locs = deriveRunLocations(
      [{ id: "r1", rows: [write("C:\\Temp\\scratch.txt")] }],
      roots,
    );
    expect(locs.get("r1")!.files).toEqual([]);
  });

  it("does not count a read-only tool as a write", () => {
    const locs = deriveRunLocations(
      [{ id: "r1", rows: [tool("Read", { file_path: `${HOME}\\a.ts` })] }],
      roots,
    );
    const loc = locs.get("r1")!;
    expect(loc.home).toBe(HOME);
    expect(loc.files).toEqual([]);
  });
});

describe("deriveRunLocations — the wrong-worktree incident", () => {
  const roots = [HOME, OTHER];

  it("flags a run that started in one worktree and then wrote into another", () => {
    // "Fix upgrade tool findings": edits in its own worktree, then — after the
    // parent moved the session cwd out from under it — a write into the other
    // agent's tree.
    const locs = deriveRunLocations(
      [{ id: "r1", rows: [edit(`${HOME}\\package.json`), write(`${OTHER}\\_patch_docs.py`)] }],
      roots,
    );
    const loc = locs.get("r1")!;
    expect(loc.home).toBe(HOME);
    expect(loc.current).toBe(OTHER);
    expect(loc.strayRoots).toEqual([OTHER]);
    expect(loc.strayFiles).toEqual([`${OTHER}\\_patch_docs.py`]);
  });

  it("flags the delegate a displaced run spawned, whose FIRST write is already wrong", () => {
    // The sub-subagent ("Apply two doc/config edits") only ever saw the wrong
    // worktree, so nothing local to it could catch this — it has to inherit its
    // displaced spawner's home. This is the edit that nearly got committed.
    const locs = deriveRunLocations(
      [
        { id: "r1", rows: [edit(`${HOME}\\package.json`), write(`${OTHER}\\_patch_docs.py`)] },
        {
          id: "r2",
          parentRunId: "r1",
          rows: [edit(`${OTHER}\\RUNNING.md`), edit(`${OTHER}\\package.json`)],
        },
      ],
      roots,
    );
    const child = locs.get("r2")!;
    expect(child.home).toBe(HOME);
    expect(child.strayRoots).toEqual([OTHER]);
    expect(child.strayFiles).toEqual([`${OTHER}\\RUNNING.md`, `${OTHER}\\package.json`]);
  });

  it("leaves an isolation:worktree subagent alone — its own tree is not a stray", () => {
    // The spawner is on its home, so the child claims the temp worktree the
    // harness made for it. Flagging this was the false positive to avoid.
    const iso = `${WT}\\agent-a66bfb6c7bf2af198`;
    const locs = deriveRunLocations(
      [
        { id: "r1", rows: [edit(`${HOME}\\a.ts`)] },
        { id: "r2", parentRunId: "r1", rows: [edit(`${iso}\\b.ts`), edit(`${iso}\\c.ts`)] },
      ],
      [HOME, iso],
    );
    const child = locs.get("r2")!;
    expect(child.home).toBe(iso);
    expect(child.strayRoots).toEqual([]);
  });

  it("does not punish a child for its parent merely VISITING another worktree", () => {
    // A parent that reads around but writes only at home is not displaced, so
    // its children still claim their own first root.
    const locs = deriveRunLocations(
      [
        { id: "r1", rows: [edit(`${HOME}\\a.ts`), bash(`cd "${OTHER}" && git log`)] },
        { id: "r2", parentRunId: "r1", rows: [edit(`${OTHER}\\b.ts`)] },
      ],
      [HOME, OTHER],
    );
    expect(locs.get("r1")!.strayRoots).toEqual([]);
    expect(locs.get("r2")!.home).toBe(OTHER);
  });
});

describe("deriveSubagentRuns — location is folded onto every run", () => {
  it("carries the incident's stray write through to the run card", () => {
    const runs = deriveSubagentRuns(
      [
        agent("t1"),
        enter(OTHER), // the main loop moves the session cwd
        edit(`${HOME}\\package.json`, "t1"),
        write(`${OTHER}\\_patch_docs.py`, "t1"),
      ],
      { worktrees: [HOME] },
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.location.strayRoots).toEqual([OTHER]);
  });

  it("gives every run a location object even when nothing located it", () => {
    const runs = deriveSubagentRuns([agent("t1")], { chatRunning: true });
    expect(runs[0]!.location).toEqual({
      roots: [],
      files: [],
      strayRoots: [],
      strayFiles: [],
    });
  });

  it("links a nested run to its spawner's home so inheritance applies end to end", () => {
    const runs = deriveSubagentRuns(
      [
        agent("t1"),
        edit(`${HOME}\\package.json`, "t1"),
        write(`${OTHER}\\_patch_docs.py`, "t1"),
        agent("t2", { parent: "t1" }),
        edit(`${OTHER}\\RUNNING.md`, "t2"),
      ],
      { worktrees: [HOME, OTHER] },
    );
    const child = runs.find((r) => r.id === "t2")!;
    expect(child.parentRunId).toBe("t1");
    expect(child.location.home).toBe(HOME);
    expect(child.location.strayFiles).toEqual([`${OTHER}\\RUNNING.md`]);
  });
});
