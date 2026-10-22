// Builds src/index.tsx into client/index.js — ONE ES module that imports
// nothing. This is the pattern the SDK's Vite preset (workstream G) packages;
// it is spelled out here so the example proves it without the SDK.
//
// WHY THE PLUGIN BELOW EXISTS. React is a singleton: a bundle carrying its own
// copy renders into the host's tree with a second dispatcher and every hook
// throws "Invalid hook call". So the host exposes its React (and react-dom,
// react/jsx-runtime, zustand, lucide-react) on `window.__dispatch.deps`, and
// this build must resolve those packages to the globals INSTEAD of bundling
// them. Rollup's `output.globals` only does that for IIFE/UMD output; an ES
// module would still carry `import ... from "react"`, which the browser
// cannot resolve. Hence a tiny plugin: each of those packages becomes a
// virtual module that reads the global and re-exports every name the real
// package has — enumerated at build time from the package itself, so
// `import { useState } from "react"` and `import { Sparkles } from
// "lucide-react"` both work unchanged and tree-shake to what is used.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** package specifier → key under `window.__dispatch.deps`. */
const DEPS = {
  react: "react",
  "react-dom": "reactDom",
  "react/jsx-runtime": "jsxRuntime",
  zustand: "zustand",
  "lucide-react": "lucide",
};

const PREFIX = "\0dispatch-global:";
const IDENT = /^[A-Za-z_$][\w$]*$/;

function dispatchGlobals() {
  return {
    name: "dispatch-globals",
    enforce: "pre",
    resolveId(id) {
      return id in DEPS ? { id: PREFIX + id, moduleSideEffects: false } : null;
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const pkg = id.slice(PREFIX.length);
      const ns = await import(pkg);
      const names = Object.keys(ns).filter((n) => n !== "default" && IDENT.test(n));
      const key = JSON.stringify(DEPS[pkg]);
      // Every export is a `/*#__PURE__*/` call, which is what lets Rollup DROP
      // the ones the plugin never imports: a bare `m["Icon"]` is a property
      // read on an object Rollup knows nothing about, so it has to keep it —
      // and every one of lucide's ~1500 icons would survive the build as a
      // line of nothing.
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

export default {
  root: here,
  plugins: [dispatchGlobals()],
  // The automatic runtime imports `react/jsx-runtime`, which the plugin above
  // resolves to the host's. No @vitejs/plugin-react: that adds fast refresh,
  // which a bundle loaded by `import()` has no use for.
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(here, "client"),
    emptyOutDir: true,
    // Readable output — this is a reference, and nothing here is secret.
    minify: false,
    lib: {
      entry: resolve(here, "src/index.tsx"),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
};
