/**
 * `cm plugin init` — scaffold a plugin that builds against `@dispatch/plugin-sdk`.
 *
 * The templates are STRINGS in this module rather than files beside it: the
 * CLI ships as `tsc` output, and `tsc` copies nothing that is not a module, so
 * a `templates/` directory would exist in a source checkout and be missing
 * from every built install. What is here is what `cm` can always produce.
 *
 * The scaffold links the SDK from the Dispatch checkout (or installed app)
 * that ran `cm` — `"@dispatch/plugin-sdk": "link:<path>"` — because the SDK is
 * versioned with the host and is not on npm. A `link:` and not a `file:`: pnpm
 * copies a `file:` directory into the store and then cannot resolve the SDK's
 * own `workspace:*` dependency on `@dispatch/shared`; a `link:` is a symlink,
 * and Node resolves the SDK's dependencies from its REAL path, inside the
 * workspace, where they exist.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID_PATTERN, PluginIdSchema } from "@dispatch/shared";
import { CmError } from "./manifest.js";

export type PluginScaffoldKind = "server" | "client" | "both";

export interface InitPluginOptions {
  /** The plugin id — also the directory name. */
  id: string;
  /** Display name; defaults to the id. */
  name?: string;
  kind: PluginScaffoldKind;
  /** Parent directory; the plugin lands at `<dir>/<id>`. Default: cwd. */
  dir?: string;
  /** The `@dispatch/plugin-sdk` package directory to link. Default: the one beside this CLI. */
  sdkPath?: string;
}

export interface InitPluginResult {
  dir: string;
  /** Relative paths written, in order. */
  files: string[];
  /** The `link:` target that went into package.json. */
  sdkLink: string;
  kind: PluginScaffoldKind;
}

/**
 * `packages/plugin-sdk`, found relative to this module: `packages/cli/dist/core/`
 * when built, `packages/cli/src/core/` under tsx — the same depth either way.
 */
export function defaultSdkPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugin-sdk");
}

/* ------------------------------------------------------------- templates */

const q = (s: string) => JSON.stringify(s);

/** Every file of the scaffold, keyed by relative path. Pure, so the tests can read them without a disk. */
export function scaffoldFiles(opts: { id: string; name: string; kind: PluginScaffoldKind; sdkLink: string }): Record<string, string> {
  const { id, name, kind, sdkLink } = opts;
  const server = kind !== "client";
  const client = kind !== "server";
  const files: Record<string, string> = {};

  files["plugin.yaml"] = [
    `# ${name} — scaffolded by \`cm plugin init\`. The manifest is validated by`,
    "# `cm plugin add` and by the host at boot; see docs/plugins.md → \"Anatomy of",
    "# a plugin\" for every field.",
    `id: ${id}`,
    `name: ${name}`,
    "version: 0.1.0",
    'dispatch: ">=1"',
    `description: ${name} — a Dispatch plugin.`,
    ...(server ? ["server: ./server/index.js", "settings: ./settings.schema.json"] : []),
    ...(client
      ? [
          "# Its directory — and ONLY its directory — is served publicly at",
          `# /plugins/${id}/. Nothing else of the plugin may live in it.`,
          "client: ./client/index.js",
        ]
      : []),
    "capabilities:",
    ...(server ? ["  - routes", "  - events", "  - kv"] : []),
    ...(client ? ["  - ui"] : []),
    "",
  ].join("\n");

  const buildSteps = [
    ...(server ? ["vite build -c vite.server.config.mjs"] : []),
    ...(client ? ["vite build -c vite.client.config.mjs"] : []),
  ];
  const pkg: Record<string, unknown> = {
    name: id,
    private: true,
    type: "module",
    version: "0.1.0",
    description: `${name} — a Dispatch plugin.`,
    scripts: {
      build: buildSteps.join(" && "),
      typecheck: "tsc --noEmit",
      ...(server ? { test: "vitest run" } : {}),
    },
    devDependencies: Object.fromEntries(
      Object.entries({
        "@dispatch/plugin-sdk": sdkLink,
        ...(server ? { "@types/node": "^26.1.0", vitest: "^4.1.11" } : {}),
        ...(client
          ? {
              "@types/react": "^18.3.18",
              "lucide-react": "^0.469.0",
              react: "^18.3.1",
              "react-dom": "^18.3.1",
              zustand: "^5.0.2",
            }
          : {}),
        typescript: "^5.7.2",
        vite: "^6.0.7",
      }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  files["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;

  files["tsconfig.json"] = `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: client ? ["ES2023", "DOM", "DOM.Iterable"] : ["ES2023"],
        module: "ESNext",
        moduleResolution: "Bundler",
        ...(client ? { jsx: "react-jsx" } : {}),
        // Pinned: left implicit, tsc sweeps in every `node_modules/@types` it
        // can reach walking up, including half-installed ones.
        types: server ? ["node"] : [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        noUncheckedIndexedAccess: true,
      },
      include: ["src", ...(server ? ["test"] : [])],
    },
    null,
    2,
  )}\n`;

  // pnpm 11 refuses to run a dependency's install script unless the project
  // lists it, and exits 1 (ERR_PNPM_IGNORED_BUILDS) rather than warning.
  // esbuild — vite's compiler — unpacks its platform binary in a postinstall,
  // so without this line the scaffold's very first `pnpm install` fails.
  files["pnpm-workspace.yaml"] = [
    "# pnpm will not run esbuild's postinstall (which unpacks its binary) unless",
    "# it is allowed here; without it `pnpm install` exits with ERR_PNPM_IGNORED_BUILDS.",
    "allowBuilds:",
    "  esbuild: true",
    "",
  ].join("\n");

  files[".gitignore"] = [
    "node_modules/",
    "# Build output of the vite configs — plugin.yaml points at these.",
    ...(server ? ["server/"] : []),
    ...(client ? ["client/"] : []),
    "",
  ].join("\n");

  if (server) {
    files["settings.schema.json"] = `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: `${name} settings`,
        type: "object",
        properties: {
          greeting: {
            type: "string",
            title: "Greeting",
            description: "What /hello answers with.",
            default: "hello",
          },
        },
      },
      null,
      2,
    )}\n`;

    files["vite.server.config.mjs"] = [
      "// src/server.ts → server/index.js: one Node ES module with every npm",
      "// dependency inlined. The host imports that file from the plugin directory,",
      "// where there is no node_modules, so a bare import would fail at activate.",
      'import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";',
      "",
      'export default dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" });',
      "",
    ].join("\n");

    files["src/server.ts"] = [
      "/**",
      ` * The server half of ${id}. \`activate(ctx)\` runs in the Dispatch server`,
      " * process after the port is open, on a 30 s budget; everything it registers",
      " * is torn down by the host when the plugin is switched off.",
      " *",
      " * Members of `ctx` are present only for the capabilities plugin.yaml",
      " * declares — this scaffold declares routes, events and kv.",
      " * See docs/plugins.md → \"Server API\".",
      " */",
      'import { definePlugin } from "@dispatch/plugin-sdk";',
      "",
      "export default definePlugin({",
      "  async activate(ctx) {",
      '    let seen = (await ctx.kv!.get<number>("seen")) ?? 0;',
      "",
      "    // Count chat status changes. Written through so a restart resumes the count.",
      '    ctx.bus!.on("chat-status", () => {',
      "      seen += 1;",
      '      void ctx.kv!.set("seen", seen);',
      "    });",
      "",
      `    // GET /api/plugins/${id}/hello — authenticated like everything under /api/.`,
      "    ctx.routes!((r) => {",
      '      r.get("/hello", async () => {',
      "        const settings = ctx.settings.get<{ greeting?: string }>();",
      '        return { greeting: settings.greeting ?? "hello", seen, plugin: ctx.id, version: ctx.version };',
      "      });",
      "    });",
      "",
      ...(client
        ? [
            "    // A plugin-event reaches this plugin's client half through host.events.onPlugin.",
            "    ctx.emit({ activated: true });",
          ]
        : []),
      "    ctx.log.info(`active — ${seen} status change(s) seen so far`);",
      "  },",
      "});",
      "",
    ].join("\n");

    files["test/server.test.ts"] = [
      "/**",
      " * `activate` under a fake context — no server. See @dispatch/plugin-sdk/testing.",
      " */",
      'import { describe, expect, it } from "vitest";',
      'import { createTestContext } from "@dispatch/plugin-sdk/testing";',
      'import plugin from "../src/server.js";',
      "",
      `describe(${q(id)}, () => {`,
      '  it("answers /hello and counts status changes into kv", async () => {',
      `    const t = createTestContext({ id: ${q(id)}, capabilities: ["routes", "events", "kv"], settings: { greeting: "hi" } });`,
      "    await plugin.activate(t.ctx);",
      "",
      '    expect((await t.routes.call("GET", "/hello")).body).toMatchObject({ greeting: "hi", seen: 0 });',
      '    t.publish({ type: "chat-status", chatId: "c1", status: "idle" });',
      '    expect((await t.routes.call("GET", "/hello")).body).toMatchObject({ seen: 1 });',
      '    expect(t.kv.get("seen")).toBe(1);',
      "  });",
      "});",
      "",
    ].join("\n");
  }

  if (client) {
    files["vite.client.config.mjs"] = [
      "// src/client.tsx → client/index.js: one ES module that imports nothing.",
      "// react, react-dom, react/jsx-runtime, zustand and lucide-react resolve to",
      "// the host's copies on window.__dispatch.deps — React must be the host's,",
      "// or every hook in the plugin throws.",
      'import { dirOf, dispatchClientBuild } from "@dispatch/plugin-sdk/vite";',
      "",
      'export default dispatchClientBuild({ root: dirOf(import.meta.url), entry: "src/client.tsx" });',
      "",
    ].join("\n");

    files["src/client.tsx"] = [
      "/**",
      ` * The client half of ${id}: \`activate(host)\` runs in the browser once the`,
      " * SPA has loaded, and registers into the host's slots. Everything clickable",
      " * is `host.ui.*` (the host forbids raw button elements, in plugins too).",
      " * See docs/plugins.md → \"Client host\".",
      " */",
      'import { Sparkles } from "lucide-react";',
      'import { defineClientPlugin, type ClientHost } from "@dispatch/plugin-sdk";',
      "",
      ...(server
        ? [
            "/** The composer control: a toolbar icon that asks the server half and toasts the answer. */",
            "function Control({ host }: { host: ClientHost }) {",
            "  const { IconButton } = host.ui;",
            "  return (",
            `    <IconButton tip=${q(name)} aria-label=${q(name)} onClick={() => void greet(host)}>`,
            "      <Sparkles />",
            "    </IconButton>",
            "  );",
            "}",
            "",
            "async function greet(host: ClientHost): Promise<void> {",
            "  // host.api.fetch is authenticated and rooted at /api/plugins/<id>/.",
            '  const res = await host.api.fetch("hello");',
            "  const body = (await res.json()) as { greeting: string; seen: number };",
            "  host.toast(`${body.greeting} — ${body.seen} status change(s) seen`);",
            "}",
          ]
        : [
            "/** The composer control: a toolbar icon that toasts. */",
            "function Control({ host }: { host: ClientHost }) {",
            "  const { IconButton } = host.ui;",
            "  return (",
            `    <IconButton tip=${q(name)} aria-label=${q(name)} onClick={() => host.toast(${q(`${name} says hello`)})}>`,
            "      <Sparkles />",
            "    </IconButton>",
            "  );",
            "}",
          ]),
      "",
      "function Settings({ host }: { host: ClientHost }) {",
      "  const { Button } = host.ui;",
      "  return (",
      '    <div className="space-y-3">',
      `      <p className="text-xs leading-relaxed text-muted">${name} is installed. This section is yours.</p>`,
      `      <Button variant="primary" size="sm" onClick={() => host.toast(${q(`${name} says hello`)})}>`,
      "        Say hello",
      "      </Button>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default defineClientPlugin({",
      "  activate(host) {",
      "    host.slots.composerControl({",
      `      id: "main",`,
      `      label: ${q(name)},`,
      `      hint: "scaffolded control",`,
      "      icon: <Sparkles />,",
      "      render: () => <Control host={host} />,",
      "      // No `menu`: the options-menu row runs onSelect instead of drilling in.",
      ...(server ? ["      onSelect: () => void greet(host),"] : [`      onSelect: () => host.toast(${q(`${name} says hello`)}),`]),
      "    });",
      "    host.slots.settingsSection({",
      `      id: "main",`,
      `      label: ${q(name)},`,
      `      blurb: "Scaffolded settings section",`,
      "      icon: Sparkles,",
      "      render: () => <Settings host={host} />,",
      "    });",
      ...(server
        ? ["    host.events.onPlugin((payload) => host.toast(`" + id + ": ${JSON.stringify(payload)}`));"]
        : []),
      "  },",
      "});",
      "",
    ].join("\n");
  }

  files["README.md"] = [
    `# ${name}`,
    "",
    `A Dispatch plugin (\`${id}\`), scaffolded by \`cm plugin init --${kind}\`.`,
    "",
    "```",
    "pnpm install",
    `pnpm build          # src/ → ${[server && "server/index.js", client && "client/index.js"].filter(Boolean).join(" and ")}`,
    ...(server ? ["pnpm test           # activate() under a fake context, no server"] : []),
    "cm plugin add . --config-dir <dispatch config dir>   # or: cm plugin link . (development)",
    "# restart Dispatch — plugins are read at boot, nothing hot-reloads",
    "```",
    "",
    "Then look under Settings → Plugins. " +
      [
        server && `\`GET /api/plugins/${id}/hello\` answers the route`,
        client && "the toolbar icon and the settings section are the client half",
      ]
        .filter(Boolean)
        .join("; ") +
      ".",
    "",
    "## Where things are",
    "",
    "| file | what |",
    "|---|---|",
    "| `plugin.yaml` | the manifest: id, entries, capabilities. Validated by `cm plugin add` and the host |",
    ...(server
      ? [
          "| `src/server.ts` | `activate(ctx)` — routes, bus, kv. Bundled to `server/index.js` with no runtime imports |",
          "| `settings.schema.json` | the form Settings → Plugins renders; read with `ctx.settings.get()` |",
          "| `test/server.test.ts` | `createTestContext` from `@dispatch/plugin-sdk/testing` |",
        ]
      : []),
    ...(client
      ? ["| `src/client.tsx` | `activate(host)` — slots, kit, toasts. Bundled to `client/index.js` against the host's React |"]
      : []),
    "",
    "`@dispatch/plugin-sdk` is linked from the Dispatch checkout that ran `cm plugin init`",
    "(`package.json` → `link:`). The reference plugins are `examples/plugins/` there, and the",
    "contract is `docs/plugins.md`.",
    "",
  ].join("\n");

  return files;
}

/* ------------------------------------------------------------------ init */

/** Scaffold `<dir>/<id>`. Refuses a non-empty target: a scaffold must never overwrite work. */
export async function initPlugin(opts: InitPluginOptions): Promise<InitPluginResult> {
  const parsed = PluginIdSchema.safeParse(opts.id);
  if (!parsed.success) {
    throw new CmError(
      `"${opts.id}" is not a valid plugin id: ${parsed.error.issues.map((i) => i.message).join("; ")} (${PLUGIN_ID_PATTERN.source})`,
    );
  }
  const id = parsed.data;
  const sdkPath = resolve(opts.sdkPath ?? defaultSdkPath());
  if (!existsSync(join(sdkPath, "package.json"))) {
    throw new CmError(
      `cannot find @dispatch/plugin-sdk at ${sdkPath}.\n` +
        "  Pass --sdk <path to a Dispatch checkout>/packages/plugin-sdk, or run cm from a checkout that has it.",
    );
  }
  const dir = resolve(opts.dir ?? process.cwd(), id);
  if (existsSync(dir)) {
    const entries = await readdir(dir);
    if (entries.length) throw new CmError(`${dir} already exists and is not empty.`);
  }
  // Relative when it can be (the scaffold and the checkout move together on
  // one machine); `path.relative` yields an absolute path across Windows
  // drives, which pnpm's `link:` also accepts.
  const rel = relative(dir, sdkPath).replace(/\\/g, "/");
  const sdkLink = `link:${rel.startsWith(".") || /^[A-Za-z]:\//.test(rel) || rel.startsWith("/") ? rel : `./${rel}`}`;
  const files = scaffoldFiles({ id, name: opts.name?.trim() || id, kind: opts.kind, sdkLink });
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(rel);
  }
  return { dir, files: written, sdkLink, kind: opts.kind };
}
