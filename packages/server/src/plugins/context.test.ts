/**
 * `buildPluginContext`'s secret members against a REAL store on a temp config
 * dir — the store is what decides "shared by both instances, encrypted", so a
 * fake would prove nothing about the part this exists for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifestSchema, SECRET_VALUE_MAX } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { SecretsService, plainKeyProtector, type SecretKey } from "../services/secrets.js";
import { buildPluginContext, newOwnedResources, type PluginContextDeps } from "./context.js";

const dirs: string[] = [];
const stores: SecretsService[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function store(configDir?: string): Promise<{ configDir: string; secrets: SecretsService }> {
  const dir = configDir ?? (await mkdtemp(join(tmpdir(), "dispatch-plugin-ctx-")));
  if (!configDir) dirs.push(dir);
  const secrets = new SecretsService({ configDir: dir, protector: plainKeyProtector });
  await secrets.start();
  stores.push(secrets);
  return { configDir: dir, secrets };
}

function context(
  secrets: SecretsService,
  opts: { capabilities: string[]; secretNames?: string[]; refresh?: (keys: SecretKey[]) => Promise<unknown> },
) {
  const manifest = PluginManifestSchema.parse({
    id: "remote-host",
    name: "Remote host",
    version: "0.1.0",
    dispatch: ">=1",
    capabilities: opts.capabilities,
    secrets: opts.secretNames ?? ["REMOTE_HOST_API", "REMOTE_HOST_KEY_*"],
  });
  const log: Array<[string, string]> = [];
  const refreshed: SecretKey[][] = [];
  const never = () => {
    throw new Error("not in this test");
  };
  const deps: PluginContextDeps = {
    store: { listProjects: never, getProject: never } as never,
    bus: new EventBus(),
    secrets,
    inspect: { findChats: never, readChat: never } as never,
    memory: { recall: never, write: never, delete: never } as never,
    attention: { list: () => [], get: () => undefined } as never,
    messenger: { send: never, ask: never, reply: never, state: never, targetOf: () => undefined } as never,
    broker: { answerQuestion: () => false, declineQuestion: () => false },
    log: {
      info: (m) => log.push(["info", m]),
      warn: (m) => log.push(["warn", m]),
      error: (m) => log.push(["error", m]),
    },
    settings: () => ({}),
    refreshSecrets:
      opts.refresh ??
      (async (keys) => {
        refreshed.push(keys);
      }),
  };
  const ctx = buildPluginContext(manifest, "/plugins/remote-host", deps, newOwnedResources());
  return { ctx, log, refreshed };
}

describe("ctx.secrets — secrets:write", () => {
  it("is read-only without secrets:write", async () => {
    const { secrets } = await store();
    const { ctx } = context(secrets, { capabilities: ["secrets"] });
    expect(ctx.secrets?.get).toBeTypeOf("function");
    expect(ctx.secrets?.set).toBeUndefined();
    expect(ctx.secrets?.delete).toBeUndefined();
  });

  it("stores a covered name in the GLOBAL store, where the other instance reads it, and refreshes its consumers", async () => {
    const { configDir, secrets } = await store();
    const { ctx, refreshed } = context(secrets, { capabilities: ["secrets", "secrets:write"] });
    await ctx.secrets!.set!("REMOTE_HOST_KEY_cvx_mac", "cvx-mac-keypair-plaintext");

    expect(await ctx.secrets!.get("REMOTE_HOST_KEY_cvx_mac")).toBe("cvx-mac-keypair-plaintext");
    expect(await ctx.secrets!.list()).toEqual(["REMOTE_HOST_KEY_cvx_mac"]);
    expect(refreshed).toEqual([[{ name: "REMOTE_HOST_KEY_cvx_mac", scope: "global" }]]);
    // Global scope, encrypted at rest.
    expect((await secrets.list()).map((s) => [s.scope, s.name])).toEqual([["global", "REMOTE_HOST_KEY_cvx_mac"]]);
    expect(await readFile(join(configDir, "secrets.json"), "utf8")).not.toContain("keypair-plaintext");
    // A second store on the same config dir is the other instance (they share config/).
    const other = await store(configDir);
    await other.secrets.list();
    expect(other.secrets.resolve(undefined, "REMOTE_HOST_KEY_cvx_mac")).toBe("cvx-mac-keypair-plaintext");
  });

  it("deletes, refreshing only when something was there", async () => {
    const { secrets } = await store();
    const { ctx, refreshed } = context(secrets, { capabilities: ["secrets", "secrets:write"] });
    await ctx.secrets!.set!("REMOTE_HOST_API", "t");
    refreshed.length = 0;
    expect(await ctx.secrets!.delete!("REMOTE_HOST_API")).toBe(true);
    expect(refreshed).toEqual([[{ name: "REMOTE_HOST_API", scope: "global" }]]);
    expect(await ctx.secrets!.get("REMOTE_HOST_API")).toBeUndefined();
    expect(await ctx.secrets!.delete!("REMOTE_HOST_API")).toBe(false);
    expect(refreshed).toHaveLength(1);
  });

  it("throws on a name the manifest does not cover, an invalid name, or an empty or oversized value — and stores nothing", async () => {
    const { secrets } = await store();
    // Something the owner saved for another purpose: a prefix must not reach it.
    await secrets.set({ scope: "global", name: "GITHUB_TOKEN" }, "ghp_x");
    const { ctx, refreshed } = context(secrets, { capabilities: ["secrets", "secrets:write"] });
    await expect(ctx.secrets!.set!("GITHUB_TOKEN", "evil")).rejects.toThrow(/not listed under secrets:/);
    await expect(ctx.secrets!.delete!("GITHUB_TOKEN")).rejects.toThrow(/not listed under secrets:/);
    await expect(ctx.secrets!.set!("REMOTE_HOST_KEY_cvx-mac", "k")).rejects.toThrow(/not a valid secret name/);
    await expect(ctx.secrets!.set!("REMOTE_HOST_KEY_a", "")).rejects.toThrow(/non-empty/);
    await expect(ctx.secrets!.set!("REMOTE_HOST_KEY_a", "x".repeat(SECRET_VALUE_MAX + 1))).rejects.toThrow(/over 64 KiB/);
    expect(secrets.resolve(undefined, "GITHUB_TOKEN")).toBe("ghp_x");
    expect((await secrets.list()).map((s) => s.name)).toEqual(["GITHUB_TOKEN"]);
    expect(await ctx.secrets!.list()).toEqual([]);
    expect(refreshed).toEqual([]);
    // Reading an uncovered name stays a warning, as it always was.
    expect(await ctx.secrets!.get("GITHUB_TOKEN")).toBeUndefined();
  });

  it("keeps a stored value when the refresh after it fails, and says so in the log", async () => {
    const { secrets } = await store();
    const { ctx, log } = context(secrets, {
      capabilities: ["secrets", "secrets:write"],
      refresh: async () => {
        throw new Error("sub-app would not restart");
      },
    });
    await expect(ctx.secrets!.set!("REMOTE_HOST_API", "t")).resolves.toBeUndefined();
    expect(secrets.resolve(undefined, "REMOTE_HOST_API")).toBe("t");
    expect(log.find(([level]) => level === "warn")?.[1]).toMatch(/saved but its consumers were not all refreshed/);
  });

  it("covers a prefix for reading too, and never lists what the manifest does not cover", async () => {
    const { secrets } = await store();
    for (const name of ["REMOTE_HOST_KEY_b", "REMOTE_HOST_KEY_a", "REMOTE_HOSTX", "OTHER"]) {
      await secrets.set({ scope: "global", name }, "v");
    }
    await secrets.set({ scope: "project", projectId: "p", name: "REMOTE_HOST_KEY_c" }, "v");
    const { ctx } = context(secrets, { capabilities: ["secrets"] });
    expect(await ctx.secrets!.list()).toEqual(["REMOTE_HOST_KEY_a", "REMOTE_HOST_KEY_b"]);
    expect(await ctx.secrets!.get("REMOTE_HOST_KEY_a")).toBe("v");
    expect(await ctx.secrets!.get("REMOTE_HOSTX")).toBeUndefined();
  });
});
