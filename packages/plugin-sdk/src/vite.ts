/**
 * `@dispatch/plugin-sdk/vite` — the two build presets.
 *
 *   dispatchClientBuild({ entry })  src/client.tsx → client/index.js, ONE ES
 *                                   module importing nothing, with react /
 *                                   react-dom / react/jsx-runtime / zustand /
 *                                   lucide-react resolved to the host's copies
 *                                   on `window.__dispatch.deps`.
 *   dispatchServerBuild({ entry })  src/server.ts → server/index.js, ONE ES
 *                                   module for Node with every npm dependency
 *                                   inlined and only Node's builtins external.
 *
 * WHY THE CLIENT PRESET EXISTS. React is a singleton: a plugin bundle carrying
 * its own copy renders into the host's tree with a second dispatcher and every
 * hook throws "Invalid hook call" — the one failure that cannot be caught per
 * plugin, because it happens inside the host's render. The host exposes its
 * React (and the four libraries a slot reaches for) on `window.__dispatch.deps`
 * (`DispatchClientGlobals` in @dispatch/shared) and this preset makes the
 * bundle read them from there. Rollup's `output.globals` only does that for
 * IIFE/UMD output; an ES module would still carry `import … from "react"`,
 * which the browser cannot resolve. So each of those packages becomes a
 * VIRTUAL module that reads the global and re-exports every name the real
 * package has — enumerated at build time from the package itself, so
 * `import { useState } from "react"` and `import { Sparkles } from
 * "lucide-react"` both work unchanged and tree-shake to what is used.
 *
 * WHY THE SERVER PRESET EXISTS. The host imports `server/index.js` straight
 * from `<configDir>/plugins/<id>/` — there is no `node_modules` beside it after
 * `cm plugin add` (which deliberately does not copy one), so a runtime import
 * of any npm package, this SDK included, fails at activate. Bundling makes the
 * module self-contained; `definePlugin` is a two-line identity and costs
 * nothing inlined.
 */
import { builtinModules } from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Plugin, UserConfig } from "vite";

/** Package specifier → key under `window.__dispatch.deps`. Mirrors `DispatchClientGlobals.deps`. */
export const DISPATCH_HOST_DEPS = {
  react: "react",
  "react-dom": "reactDom",
  "react/jsx-runtime": "jsxRuntime",
  zustand: "zustand",
  "lucide-react": "lucide",
} as const;

export type HostDepSpecifier = keyof typeof DISPATCH_HOST_DEPS;

const PREFIX = "\0dispatch-global:";
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Import `pkg` for its export list. From the PLUGIN's root first, so the names
 * match the types the author compiled against; from this package otherwise,
 * so a plugin that declares none of the five (it only uses the host's React
 * through `host.React`) still builds. Either way the names are a superset of
 * what the host exposes only if versions drift — and a name the host lacks
 * reads `undefined` at runtime, which is the author's version mismatch to fix,
 * not a build error to hide.
 */
async function exportsOf(pkg: string, root: string): Promise<string[]> {
  const candidates = [resolve(root, "package.json"), import.meta.url];
  let lastErr: unknown;
  for (const from of candidates) {
    try {
      const require = createRequire(from.startsWith("file:") ? from : pathToFileURL(from).href);
      const resolved = require.resolve(pkg);
      const ns = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
      return Object.keys(ns).filter((n) => n !== "default" && IDENT.test(n));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`@dispatch/plugin-sdk: cannot enumerate the exports of "${pkg}" — install it as a devDependency of the plugin. ${String(lastErr)}`);
}

/**
 * The Vite plugin alone, for a config that is not the preset's: resolves the
 * five host packages to virtual modules over `window.__dispatch.deps`.
 */
export function dispatchGlobals(opts: { root?: string } = {}): Plugin {
  const root = opts.root ?? process.cwd();
  return {
    name: "dispatch-globals",
    enforce: "pre",
    resolveId(id) {
      return id in DISPATCH_HOST_DEPS ? { id: PREFIX + id, moduleSideEffects: false } : null;
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const pkg = id.slice(PREFIX.length) as HostDepSpecifier;
      const names = await exportsOf(pkg, root);
      const key = JSON.stringify(DISPATCH_HOST_DEPS[pkg]);
      // Every export is a `/*#__PURE__*/` call, which is what lets Rollup DROP
      // the ones the plugin never imports: a bare `m["Icon"]` is a property
      // read on an object Rollup knows nothing about, so it has to keep it —
      // and every one of lucide's ~1500 icons would survive the build as a
      // line of nothing (112 kB instead of 5 kB, measured on hello-slot).
      return [
        `const m = window.__dispatch.deps[${key}];`,
        "const pick = (k) => m[k];",
        // The host stores `import * as react`, so the React object itself is
        // `m.default` under CJS interop and `m` when the package is ESM.
        "const dflt = () => m.default ?? m;",
        "export default /*#__PURE__*/ dflt();",
        ...names.map((n) => `export const ${n} = /*#__PURE__*/ pick(${JSON.stringify(n)});`),
      ].join("\n");
    },
  };
}

export interface ClientBuildOptions {
  /** The client entry, e.g. `src/client.tsx`. Relative to `root`. */
  entry: string;
  /** The plugin directory. Defaults to the cwd — `vite build` is run from the plugin. */
  root?: string;
  /** Where `index.js` lands. Default `client` — what `plugin.yaml`'s `client: ./client/index.js` names. */
  outDir?: string;
  /** Minify the bundle. Default false: a plugin is small and its author will read the output. */
  minify?: boolean;
  /** Extra Vite plugins, appended after the globals one. */
  plugins?: Plugin[];
}

/** A `vite build` config producing `<outDir>/index.js` against the host's globals shim. */
export function dispatchClientBuild(opts: ClientBuildOptions): UserConfig {
  const root = resolve(opts.root ?? process.cwd());
  return {
    root,
    plugins: [dispatchGlobals({ root }), ...(opts.plugins ?? [])],
    // The automatic runtime imports `react/jsx-runtime`, which the plugin
    // above resolves to the host's. No @vitejs/plugin-react: that adds fast
    // refresh, which a bundle loaded by `import()` has no use for.
    esbuild: { jsx: "automatic" },
    build: {
      outDir: resolve(root, opts.outDir ?? "client"),
      emptyOutDir: true,
      minify: opts.minify ?? false,
      lib: {
        entry: resolve(root, opts.entry),
        formats: ["es"],
        fileName: () => "index.js",
      },
    },
  };
}

export interface ServerBuildOptions {
  /** The server entry, e.g. `src/server.ts`. Relative to `root`. */
  entry: string;
  root?: string;
  /** Where `index.js` lands. Default `server` — what `plugin.yaml`'s `server: ./server/index.js` names. */
  outDir?: string;
  /** Packages to leave as bare imports. Default none — see the module comment. */
  external?: string[];
  /** The Node the host runs. Default `node24`, the host's floor. */
  target?: string;
}

/** Node's builtins under both spellings; nothing else is external by default. */
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** A `vite build` config producing one self-contained Node ES module at `<outDir>/index.js`. */
export function dispatchServerBuild(opts: ServerBuildOptions): UserConfig {
  const root = resolve(opts.root ?? process.cwd());
  const external = new Set(opts.external ?? []);
  return {
    root,
    build: {
      outDir: resolve(root, opts.outDir ?? "server"),
      emptyOutDir: true,
      minify: false,
      target: opts.target ?? "node24",
      // `ssr` rather than `lib`: it is what makes Vite resolve packages with
      // Node's export conditions instead of the browser's. With `lib` alone a
      // dependency that ships a browser build would be bundled in that form.
      ssr: resolve(root, opts.entry),
      rollupOptions: {
        external: (id) => NODE_BUILTINS.has(id) || external.has(id),
        output: { format: "es", entryFileNames: "index.js" },
      },
    },
    // `noExternal: true` is the "inline everything" switch; without it an SSR
    // build leaves every dependency as a bare import, which is exactly the
    // failure this preset exists to prevent.
    ssr: { noExternal: true, target: "node" },
  };
}

/**
 * The directory of the config file that called us — a convenience for `root`.
 * `fileURLToPath`, not `new URL(...).pathname`: the pathname is still
 * percent-encoded, so a plugin under `C:\Users\John Smith\` would have resolved
 * to `John%20Smith`, a directory that does not exist, and every build would
 * have failed on "entry not found".
 */
export function dirOf(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
