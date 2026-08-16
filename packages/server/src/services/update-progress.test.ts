/**
 * Phase derivation from the installer's output.
 *
 * These fixtures are copied from what `tools/install.mjs` actually prints. That
 * is the point of the file: the mapping is a coupling to another script's prose,
 * so the only thing that makes it safe is a test that fails loudly when the two
 * drift. If you change a message in the installer, one of these breaks — fix the
 * marker, don't loosen the test.
 *
 * The append-mode case is the one worth reading. `update.log` is opened with
 * `"a"` and never rotated, so it accumulates every install the machine has ever
 * run. Without `logOffset` a reader finds the PREVIOUS install's "is installed."
 * and reports the current one as finished — which, for a screen whose job is to
 * decide when to reload, means reloading into a build that is still being
 * unpacked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateProgress } from "./update-progress.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dispatch-progress-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stamp(over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(root, "update.json"),
    JSON.stringify({
      phase: "launched",
      tag: "v2026.08.16.00001",
      startedAt: new Date().toISOString(),
      logOffset: 0,
      ...over,
    }),
    "utf8",
  );
}

async function log(text: string): Promise<void> {
  await writeFile(join(root, "update.log"), text, "utf8");
}

const read = () => readUpdateProgress({ root, includeLog: true });

/** Real installer output, in order, up to the point named. */
const TRANSCRIPT = [
  "Resolving v2026.08.16.00001 from mdennis281/dispatch...",
  "release: v2026.08.16.00001",
  "target : C:\\Users\\x\\AppData\\Local\\claude-manager",
  "verified: sha256 9f2c1b0e5d4a3f6c8b7e2d1a0c9f8e7d6b5a4c3f2e1d0b9a8c7f6e5d4b3a2c1d",
  "  $ tar -xzf C:\\Temp\\payload.tgz -C C:\\Users\\x\\AppData\\Local\\claude-manager\\.install-1",
  "installing runtime dependencies...",
  "  $ pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false",
  "Packages: +527",
  "stopping the current Dispatch instance, if it is running...",
  "  $ py -3 C:\\app\\tools\\app\\launch.py --stop --target C:\\root",
  "asked Dispatch to stop (pid 4242) - stopping agents and subApps...",
  "stopped.",
  "  $ pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false",
  "  $ py -3 C:\\app\\tools\\app\\launch.py --no-window --target C:\\root",
  "starting Dispatch on 4318...",
  "Dispatch is up at http://127.0.0.1:4318",
  "Dispatch v2026.08.16.00001 is installed.",
];

const upTo = (line: string) => TRANSCRIPT.slice(0, TRANSCRIPT.indexOf(line) + 1).join("\n");

describe("readUpdateProgress", () => {
  it("is idle when no install has ever run here", async () => {
    expect(await read()).toMatchObject({ inFlight: false, phase: "idle", tag: null });
  });

  it("is launching when the stamp exists but nothing has been printed", async () => {
    await stamp();
    expect(await read()).toMatchObject({ inFlight: true, phase: "launching" });
  });

  it.each([
    ["Resolving v2026.08.16.00001 from mdennis281/dispatch...", "resolving"],
    ["release: v2026.08.16.00001", "downloading"],
    ["verified: sha256 9f2c1b0e5d4a3f6c8b7e2d1a0c9f8e7d6b5a4c3f2e1d0b9a8c7f6e5d4b3a2c1d", "verifying"],
    ["installing runtime dependencies...", "dependencies"],
    ["stopping the current Dispatch instance, if it is running...", "stopping"],
    ["starting Dispatch on 4318...", "starting"],
    ["Dispatch v2026.08.16.00001 is installed.", "done"],
  ])("reads %s as %s", async (line, phase) => {
    await stamp();
    await log(upTo(line));
    expect(await read()).toMatchObject({ phase });
  });

  it("distinguishes the post-swap pnpm run from the pre-swap one", async () => {
    // Both are the identical command echo. Only position tells them apart, and
    // the second is the only evidence anywhere in the log that the swap worked.
    await stamp();
    await log(upTo("  $ pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false"));
    expect((await read()).phase).toBe("dependencies");

    await log(TRANSCRIPT.slice(0, TRANSCRIPT.lastIndexOf("  $ pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false") + 1).join("\n"));
    expect((await read()).phase).toBe("relinking");
  });

  it("reports done as finished, not in flight", async () => {
    await stamp();
    await log(TRANSCRIPT.join("\n"));
    expect(await read()).toMatchObject({ inFlight: false, phase: "done" });
  });

  it("surfaces the installer's failure line and outranks how far it got", async () => {
    await stamp();
    await log(`${upTo("starting Dispatch on 4318...")}\nDispatch install failed: server did not come up on 4318 within 60s`);
    expect(await read()).toMatchObject({
      inFlight: false,
      phase: "failed",
      failure: "server did not come up on 4318 within 60s",
    });
  });

  it("ignores a PREVIOUS install's output via logOffset", async () => {
    // The exact bug append-mode invites: a completed update sitting above the
    // one that is actually running.
    const previous = `${TRANSCRIPT.join("\n")}\n`;
    await log(previous);
    await stamp({ logOffset: Buffer.byteLength(previous, "utf8") });
    await appendFile(join(root, "update.log"), "Resolving v2026.08.16.00002 from mdennis281/dispatch...\n", "utf8");

    expect(await read()).toMatchObject({ inFlight: true, phase: "resolving" });
  });

  it("does not inherit a previous install's failure either", async () => {
    const previous = "Dispatch install failed: checksum mismatch\n";
    await log(previous);
    await stamp({ logOffset: Buffer.byteLength(previous, "utf8") });
    await appendFile(join(root, "update.log"), `${upTo("installing runtime dependencies...")}\n`, "utf8");

    expect(await read()).toMatchObject({ phase: "dependencies", failure: null });
  });

  it("falls back to a plain tail when the log is shorter than the offset", async () => {
    // The log was replaced or truncated out from under us; the offset is then
    // meaningless and must not be trusted into reading past the end.
    await stamp({ logOffset: 10_000 });
    await log(upTo("installing runtime dependencies..."));
    expect((await read()).phase).toBe("dependencies");
  });

  it("withholds the log tail from an unauthenticated caller but still reports the phase", async () => {
    await stamp();
    await log(upTo("installing runtime dependencies..."));
    const quiet = await readUpdateProgress({ root, includeLog: false });
    expect(quiet.phase).toBe("dependencies");
    expect(quiet.log).toBeUndefined();
    expect((await read()).log).toContain("installing runtime dependencies...");
  });

  it("survives an unreadable stamp rather than throwing at the route", async () => {
    await writeFile(join(root, "update.json"), "{ not json", "utf8");
    expect(await read()).toMatchObject({ phase: "idle", inFlight: false });
  });
});
