import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PluginManifestSchema } from "@dispatch/shared";
import { defaultSdkPath, initPlugin, scaffoldFiles } from "./plugin-init.js";
import { CmError } from "./manifest.js";

let root: string;
let sdk: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-plugin-init-"));
  // A stand-in SDK directory: init only checks that a package.json is there.
  sdk = join(root, "sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, "package.json"), '{"name":"@dispatch/plugin-sdk"}');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scaffoldFiles", () => {
  it("produces a manifest the shared schema accepts, for every kind", () => {
    for (const kind of ["server", "client", "both"] as const) {
      const files = scaffoldFiles({ id: "my-plugin", name: "My plugin", kind, sdkLink: "link:../sdk" });
      const manifest = PluginManifestSchema.safeParse(parseYaml(files["plugin.yaml"]!));
      expect(manifest.success, `${kind}: ${JSON.stringify(manifest.error?.issues)}`).toBe(true);
      expect(manifest.data!.id).toBe("my-plugin");
      expect(!!manifest.data!.server, kind).toBe(kind !== "client");
      expect(!!manifest.data!.client, kind).toBe(kind !== "server");
      // The client entry sits in its own directory — the schema's public-dir rule.
      if (manifest.data!.client) expect(manifest.data!.client).toBe("./client/index.js");
    }
  });

  it("writes only the half that was asked for, and links the SDK", () => {
    const server = scaffoldFiles({ id: "s", name: "S", kind: "server", sdkLink: "link:../sdk" });
    expect(Object.keys(server).sort()).toEqual(
      [".gitignore", "README.md", "package.json", "plugin.yaml", "settings.schema.json", "src/server.ts", "test/server.test.ts", "tsconfig.json", "vite.server.config.mjs"].sort(),
    );
    const client = scaffoldFiles({ id: "c", name: "C", kind: "client", sdkLink: "link:../sdk" });
    expect(Object.keys(client)).not.toContain("src/server.ts");
    expect(Object.keys(client)).toContain("src/client.tsx");
    expect(Object.keys(client)).not.toContain("test/server.test.ts");

    const pkg = JSON.parse(server["package.json"]!) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.devDependencies["@dispatch/plugin-sdk"]).toBe("link:../sdk");
    expect(pkg.devDependencies.react).toBeUndefined();
    expect(pkg.scripts.build).toBe("vite build -c vite.server.config.mjs");
    const both = JSON.parse(scaffoldFiles({ id: "b", name: "B", kind: "both", sdkLink: "link:x" })["package.json"]!) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(both.scripts.build).toBe("vite build -c vite.server.config.mjs && vite build -c vite.client.config.mjs");
    expect(both.devDependencies.react).toBeDefined();
  });

  it("uses the SDK helpers, never a raw button, and bundles the server half", () => {
    const files = scaffoldFiles({ id: "b", name: "B", kind: "both", sdkLink: "link:x" });
    expect(files["src/server.ts"]).toContain('from "@dispatch/plugin-sdk"');
    expect(files["src/server.ts"]).toContain("definePlugin(");
    expect(files["src/client.tsx"]).toContain("defineClientPlugin(");
    expect(files["src/client.tsx"]).not.toMatch(/<button[\s>]/);
    expect(files["vite.server.config.mjs"]).toContain("dispatchServerBuild");
    expect(files["vite.client.config.mjs"]).toContain("dispatchClientBuild");
    expect(files["test/server.test.ts"]).toContain("@dispatch/plugin-sdk/testing");
  });
});

describe("initPlugin", () => {
  it("writes the scaffold under <dir>/<id> with a relative SDK link", async () => {
    const result = await initPlugin({ id: "hello-world", name: "Hello world", kind: "both", dir: root, sdkPath: sdk });
    expect(result.dir).toBe(join(root, "hello-world"));
    expect(result.sdkLink).toBe("link:../sdk");
    expect(existsSync(join(result.dir, "src", "server.ts"))).toBe(true);
    expect(existsSync(join(result.dir, "src", "client.tsx"))).toBe(true);
    const pkg = JSON.parse(await readFile(join(result.dir, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@dispatch/plugin-sdk"]).toBe("link:../sdk");
    expect(await readFile(join(result.dir, "plugin.yaml"), "utf8")).toContain("name: Hello world");
  });

  it("refuses an invalid or reserved id, a missing SDK, and a non-empty target", async () => {
    await expect(initPlugin({ id: "Bad Id", kind: "server", dir: root, sdkPath: sdk })).rejects.toBeInstanceOf(CmError);
    await expect(initPlugin({ id: "dispatch-x", kind: "server", dir: root, sdkPath: sdk })).rejects.toThrow(/reserved/);
    await expect(initPlugin({ id: "ok", kind: "server", dir: root, sdkPath: join(root, "nope") })).rejects.toThrow(/--sdk/);
    await mkdir(join(root, "taken"));
    await writeFile(join(root, "taken", "x"), "x");
    await expect(initPlugin({ id: "taken", kind: "server", dir: root, sdkPath: sdk })).rejects.toThrow(/not empty/);
    expect(existsSync(join(root, "ok"))).toBe(false);
  });

  it("finds the real SDK beside this CLI in the workspace", () => {
    // The scaffold's link target must be a real package in a source checkout;
    // this is what `cm plugin init` with no --sdk relies on.
    expect(existsSync(join(defaultSdkPath(), "package.json"))).toBe(true);
  });
});
