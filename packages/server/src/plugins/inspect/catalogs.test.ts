/**
 * Plugin catalogs: the built-in one is always listed and never removable, an
 * add is refused until the URL has been read, a failed refresh keeps the last
 * good listing, a switched-off catalog is never fetched, and `installed` is
 * re-read on every read rather than frozen at refresh time.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGIN_CATALOG,
  catalogIdFor,
  sameCatalogUrl,
  type PluginCollectionInspection,
  type PluginInspectResult,
  type PluginInspection,
} from "@dispatch/shared";
import type { AppSettings } from "../../store/index.js";
import { PluginCatalogService } from "./catalogs.js";
import { PluginInspectError } from "./url.js";

const SHA = "c".repeat(40);

function report(id: string, subdir: string, url: string, version = "1.0.0"): PluginInspection {
  return {
    source: { url, host: "github", repo: "acme/plugins", cloneUrl: `${url}.git`, ref: "main", sha: SHA, subdir },
    fetched: { files: 3, bytes: 100, skipped: [] },
    valid: true,
    errors: [],
    installable: true,
    id,
    name: id.toUpperCase(),
    version,
    readme: { file: "README.md", excerpt: `# ${id}` },
    compatibility: { hostApi: 1, compatible: true },
    entries: {},
    capabilities: [{ name: "routes", line: "serve HTTP routes", used: true }],
    contributions: { modes: [], skills: [], instructions: [], personas: [], mcpServers: [], processes: [] },
    secrets: [],
    oauth: [],
    scan: { files: [], note: "" },
    hooks: [],
    mismatches: { undeclared: [], unused: [] },
    warnings: ["one"],
  };
}

function collection(url: string, members: Array<[id: string, version?: string]>): PluginCollectionInspection {
  return {
    kind: "collection",
    source: { url, host: "github", repo: "acme/plugins", cloneUrl: `${url}.git`, ref: "main", sha: SHA, subdir: "" },
    name: "Acme",
    listedBy: "manifest",
    manifestErrors: [],
    plugins: members.map(([id, v]) => ({ subdir: `plugins/${id}`, report: report(id, `plugins/${id}`, url, v) })),
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function harness(
  answers: Record<string, PluginInspectResult | Error>,
  opts: { cacheFile?: string; settings?: AppSettings } = {},
) {
  let settings: AppSettings = opts.settings ?? { theme: "dark" };
  const fetched: string[] = [];
  const installed = new Map<string, string>();
  const make = () =>
    new PluginCatalogService({
      intervalHours: 6,
      ...(opts.cacheFile ? { cacheFile: opts.cacheFile } : {}),
      settings: {
        get: async () => settings,
        update: async (fn) => (settings = fn(settings)),
      },
      inspector: {
        inspect: async (url) => {
          fetched.push(url);
          const a = answers[url];
          if (!a) throw new PluginInspectError(`nothing at ${url}`, 404);
          if (a instanceof Error) throw a;
          return structuredClone(a);
        },
        installedState: async (r) => {
          const v = r.id ? installed.get(r.id) : undefined;
          return v ? { version: v, comparison: v === r.version ? "same" : "newer" } : undefined;
        },
      },
    });
  return { svc: make(), make, fetched, installed, settings: () => settings };
}

const BUILTIN = BUILTIN_PLUGIN_CATALOG.url;
const ACME = "https://github.com/acme/plugins";

describe("PluginCatalogService", () => {
  it("lists the built-in catalog, enabled, before anything has been fetched", async () => {
    const { svc, fetched } = harness({});
    const s = await svc.status();
    expect(s.catalogs).toHaveLength(1);
    expect(s.catalogs[0]).toMatchObject({ id: BUILTIN_PLUGIN_CATALOG.id, builtin: true, enabled: true, plugins: [] });
    expect(fetched).toEqual([]);
  });

  it("refresh lists every member, and installed state is read live on each read", async () => {
    const { svc, installed } = harness({ [BUILTIN]: collection(BUILTIN, [["alpha", "1.1.0"], ["beta"]]) });
    const c = await svc.refresh(BUILTIN_PLUGIN_CATALOG.id);
    expect(c.refreshedAt).toBeDefined();
    expect(c.name).toBe("Acme");
    expect(c.plugins.map((p) => [p.id, p.subdir, p.capabilities, p.warnings])).toEqual([
      ["alpha", "plugins/alpha", ["routes"], 1],
      ["beta", "plugins/beta", ["routes"], 1],
    ]);
    expect(c.plugins[0]!.installed).toBeUndefined();

    // Installed AFTER the refresh: no second fetch, and the row knows.
    installed.set("alpha", "1.0.0");
    const again = (await svc.status()).catalogs[0]!;
    expect(again.plugins[0]!.installed).toEqual({ version: "1.0.0", comparison: "newer" });
    const full = await svc.member(BUILTIN_PLUGIN_CATALOG.id, "plugins/alpha");
    expect(full.readme?.excerpt).toBe("# alpha");
    expect(full.installed).toEqual({ version: "1.0.0", comparison: "newer" });
  });

  it("a failed refresh keeps the last good listing and says why", async () => {
    const answers: Record<string, PluginInspectResult | Error> = { [BUILTIN]: collection(BUILTIN, [["alpha"]]) };
    const { svc } = harness(answers);
    const good = await svc.refresh(BUILTIN_PLUGIN_CATALOG.id);
    answers[BUILTIN] = new PluginInspectError("github.com timed out", 504);
    const bad = await svc.refresh(BUILTIN_PLUGIN_CATALOG.id);
    expect(bad.error).toBe("github.com timed out");
    expect(bad.refreshedAt).toBe(good.refreshedAt);
    expect(bad.plugins.map((p) => p.id)).toEqual(["alpha"]);
  });

  it("a URL holding one plugin is a one-row catalog", async () => {
    const one = `${ACME}/tree/main/solo`;
    const { svc } = harness({ [one]: report("solo", "solo", one) });
    const c = await svc.add(one);
    expect(c.plugins.map((p) => [p.id, p.subdir])).toEqual([["solo", "solo"]]);
  });

  it("add reads the URL first: a URL with no plugins is refused and nothing is saved", async () => {
    const { svc, settings } = harness({});
    await expect(svc.add(ACME)).rejects.toMatchObject({ status: 404 });
    expect(settings().pluginCatalogs).toBeUndefined();
  });

  it("add saves an id from the URL, lists it after the built-in one, and refuses the same URL twice", async () => {
    const { svc, settings } = harness({ [ACME]: collection(ACME, [["gamma"]]) });
    const c = await svc.add(ACME, "Acme stuff");
    expect(c).toMatchObject({ id: "acme-plugins", label: "Acme stuff", builtin: false, enabled: true });
    expect(c.plugins.map((p) => p.id)).toEqual(["gamma"]);
    expect(settings().pluginCatalogs?.added?.map((a) => a.id)).toEqual(["acme-plugins"]);
    expect((await svc.status()).catalogs.map((x) => x.id)).toEqual([BUILTIN_PLUGIN_CATALOG.id, "acme-plugins"]);
    await expect(svc.add(`${ACME}.git/`)).rejects.toMatchObject({ status: 409 });
    await expect(svc.add(BUILTIN)).rejects.toMatchObject({ status: 409 });
  });

  it("the built-in catalog can be switched off but never removed; an added one can be removed", async () => {
    const { svc, fetched } = harness({ [ACME]: collection(ACME, [["gamma"]]), [BUILTIN]: collection(BUILTIN, [["alpha"]]) });
    await expect(svc.remove(BUILTIN_PLUGIN_CATALOG.id)).rejects.toMatchObject({ status: 409 });
    const off = await svc.setEnabled(BUILTIN_PLUGIN_CATALOG.id, false);
    expect(off).toMatchObject({ enabled: false, plugins: [] });
    await expect(svc.refresh(BUILTIN_PLUGIN_CATALOG.id)).rejects.toMatchObject({ status: 409 });

    await svc.add(ACME);
    fetched.length = 0;
    await svc.refreshAll();
    expect(fetched).toEqual([ACME]);

    await svc.remove("acme-plugins");
    expect((await svc.status()).catalogs.map((x) => x.id)).toEqual([BUILTIN_PLUGIN_CATALOG.id]);
    await expect(svc.member("acme-plugins", "plugins/gamma")).rejects.toMatchObject({ status: 404 });
  });

  it("switching a never-read catalog on reads it at once", async () => {
    const { svc, fetched } = harness(
      { [BUILTIN]: collection(BUILTIN, [["alpha"]]) },
      { settings: { theme: "dark", pluginCatalogs: { disabled: [BUILTIN_PLUGIN_CATALOG.id] } } },
    );
    const on = await svc.setEnabled(BUILTIN_PLUGIN_CATALOG.id, true);
    expect(fetched).toEqual([BUILTIN]);
    expect(on.plugins.map((p) => p.id)).toEqual(["alpha"]);
  });

  it("two refreshes of one catalog at once share one fetch", async () => {
    const { svc, fetched } = harness({ [BUILTIN]: collection(BUILTIN, [["alpha"]]) });
    await Promise.all([svc.refresh(BUILTIN_PLUGIN_CATALOG.id), svc.refresh(BUILTIN_PLUGIN_CATALOG.id)]);
    expect(fetched).toEqual([BUILTIN]);
  });

  it("member() 404s a subdir the catalog does not list", async () => {
    const { svc } = harness({ [BUILTIN]: collection(BUILTIN, [["alpha"]]) });
    await svc.refresh(BUILTIN_PLUGIN_CATALOG.id);
    await expect(svc.member(BUILTIN_PLUGIN_CATALOG.id, "plugins/../../etc")).rejects.toMatchObject({ status: 404 });
  });

  it("the listing survives a restart through the cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-catalogs-"));
    dirs.push(dir);
    const cacheFile = join(dir, "plugin-catalogs.json");
    const h = harness({ [BUILTIN]: collection(BUILTIN, [["alpha"], ["beta"]]) }, { cacheFile });
    await h.svc.refresh(BUILTIN_PLUGIN_CATALOG.id);
    await h.svc.drain();

    const restarted = h.make();
    const fetchedBefore = h.fetched.length;
    const s = await restarted.status();
    expect(s.catalogs[0]!.plugins.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(h.fetched.length).toBe(fetchedBefore);
  });
});

describe("catalog ids and URLs", () => {
  it("derives an id from the repository path, unique against those taken", () => {
    expect(catalogIdFor("https://github.com/acme/dispatch-extras", [])).toBe("acme-dispatch-extras");
    expect(catalogIdFor("https://github.com/acme/x/tree/main/plugins", [])).toBe("acme-x");
    expect(catalogIdFor("https://github.com/acme/x", ["acme-x"])).toBe("acme-x-2");
  });

  it("treats .git, trailing slashes, case and the scp form as the same URL", () => {
    expect(sameCatalogUrl("https://github.com/Acme/X.git", "https://github.com/acme/x/")).toBe(true);
    expect(sameCatalogUrl("git@github.com:acme/x.git", "https://github.com/acme/x")).toBe(true);
    expect(sameCatalogUrl("github.com/acme/x", "https://github.com/acme/x")).toBe(true);
    expect(sameCatalogUrl("https://github.com/acme/x", "https://github.com/acme/y")).toBe(false);
  });
});
