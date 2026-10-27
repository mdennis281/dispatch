import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferClaudeSession } from "./account.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "dispatch-claude-acct-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("transferClaudeSession", () => {
  const id = "0b7e3d1c-2f7a-4d8e-9c1a-5b6f7e8d9a0b";

  async function seed(dir: string, body: string) {
    const slug = join(dir, "projects", "C--repo");
    await mkdir(join(slug, id, "subagents"), { recursive: true });
    await writeFile(join(slug, `${id}.jsonl`), body);
    await writeFile(join(slug, id, "subagents", "a.jsonl"), "sub");
  }

  it("copies the session and its subagent sidecar into the same slug dir", async () => {
    const from = join(home, ".claude");
    const to = join(home, ".claude2");
    await seed(from, "from");
    expect(await transferClaudeSession(id, from, to)).toBe(true);
    expect(await readFile(join(to, "projects", "C--repo", `${id}.jsonl`), "utf8")).toBe("from");
    expect(existsSync(join(to, "projects", "C--repo", id, "subagents", "a.jsonl"))).toBe(true);
  });

  it("replaces a stale copy when switching BACK to an account the chat left", async () => {
    // The source is where the chat last ran, so it holds the newest turns; the
    // target's leftover copy predates them.
    const from = join(home, ".claude2");
    const to = join(home, ".claude");
    await seed(to, "stale, from before the switch");
    await seed(from, "with the turns taken since");
    expect(await transferClaudeSession(id, from, to)).toBe(true);
    expect(await readFile(join(to, "projects", "C--repo", `${id}.jsonl`), "utf8")).toBe(
      "with the turns taken since",
    );
  });

  it("reports false when there is nothing to carry", async () => {
    expect(await transferClaudeSession(id, join(home, ".claude"), join(home, "x"))).toBe(false);
    expect(await transferClaudeSession("../escape", home, join(home, "x"))).toBe(false);
  });
});
