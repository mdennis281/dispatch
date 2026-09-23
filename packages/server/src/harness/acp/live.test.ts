import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpHarness, ollamaHost } from "./index.js";
import type { HarnessEvent } from "../types.js";

/**
 * END-TO-END against a REAL agent and a REAL model.
 *
 * Opt-in via `DISPATCH_ACP_LIVE=1`, because it needs a goose binary, a
 * reachable Ollama and a GPU with a model already pulled — none of which a CI
 * runner has. Everything it asserts is covered by the scripted tests too; what
 * this adds is the thing scripted tests structurally cannot prove, which is
 * that the frames we think goose emits are the frames goose emits.
 *
 * Run it with, e.g.:
 *   DISPATCH_ACP_LIVE=1 OLLAMA_HOST=http://10.0.0.77:11434 \
 *     pnpm --filter @dispatch/server exec vitest run src/harness/acp/live.test.ts
 */
const LIVE = process.env.DISPATCH_ACP_LIVE === "1";

/** Local models are slow; a full agentic turn can genuinely take minutes. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

describe.skipIf(!LIVE)("ACP harness against a live agent", () => {
  const harness = new AcpHarness();
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-live-"));
  });

  it("finds an installed goose", () => {
    const rt = harness.runtime();
    expect(rt.available, `goose not found — ${JSON.stringify(rt)}`).toBe(true);
    expect(rt.version).toMatch(/^\d+\.\d+/);
  });

  it("lists the models Ollama has actually pulled", async () => {
    const models = await harness.listModels({ refresh: true });
    expect(models.length, `no models from ${ollamaHost()}`).toBeGreaterThan(0);
    // A real tag, not the static seed: seeds carry no description.
    expect(models.some((m) => m.value.includes(":"))).toBe(true);
  });

  it(
    "runs a whole turn: tool call, tool result, assistant text, turn end",
    { timeout: TURN_TIMEOUT_MS },
    async () => {
      const models = await harness.listModels();
      const model = models.find((m) => m.value.startsWith("qwen"))?.value ?? models[0]!.value;

      const session = harness.createSession({
        cwd: dir,
        // `dontAsk` so the agent proceeds without a human; the permission path
        // has its own scripted coverage.
        permissionMode: "dontAsk",
        effort: "medium",
        model,
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      });

      const events: HarnessEvent[] = [];
      const done = (async () => {
        for await (const e of session.events) {
          events.push(e);
          if (e.type === "turn-end") break;
        }
      })();

      session.send({
        text:
          "Use your tools to create a file called hello.txt in the current directory " +
          "containing exactly the word banana. Do not explain, just do it.",
      });
      await done;
      await session.dispose();

      const kinds = events.map((e) => e.type);
      expect(kinds, `events: ${kinds.join(",")}`).toContain("init");
      expect(kinds).toContain("tool-use");
      expect(kinds).toContain("turn-end");

      // The whole point of the naming layer: goose's `shell`/`write` must have
      // arrived under names the rest of Dispatch already understands.
      const tools = events.filter((e) => e.type === "tool-use") as { name: string }[];
      expect(tools.every((t) => typeof t.name === "string" && t.name.length > 0)).toBe(true);

      // And the agent must have really touched the filesystem.
      const file = join(dir, "hello.txt");
      expect(existsSync(file), `agent did not create ${file}`).toBe(true);
      expect(readFileSync(file, "utf8").toLowerCase()).toContain("banana");

      const end = events.at(-1) as { type: string; ok: boolean };
      expect(end).toMatchObject({ type: "turn-end", ok: true });

      rmSync(dir, { recursive: true, force: true });
    },
  );
});
