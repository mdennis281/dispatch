import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { buildVersion } from "@dispatch/shared";

const configuredBuildVersion = process.env.DISPATCH_BUILD_VERSION;
if (configuredBuildVersion && !/^\d{4}\.\d{2}\.\d{2}\.\d{5}$/.test(configuredBuildVersion)) {
  throw new Error(`invalid DISPATCH_BUILD_VERSION: ${configuredBuildVersion}`);
}

/**
 * Vite config for the Dispatch SPA.
 * - In dev, @dispatch/server runs Vite in middleware mode and serves this SPA + HMR on
 *   its own port (4319), so /api and /ws are same-origin — no proxy needed. See
 *   packages/server/src/dev-vite.ts.
 * - Build output goes to ./dist, which @dispatch/server serves as ../client/dist in prod.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Stamped when this config is EVALUATED: once per `vite build` in prod, and
    // once per dev-server start in dev (dev-vite.ts imports this file). That is
    // the intent — the number the sidebar shows is when the running bundle was
    // built, not when the page was loaded.
    // Release CI supplies one stamp for the bundle, tag, archive, and manifest.
    // Local builds still stamp the moment Vite evaluates this configuration.
    __BUILD_VERSION__: JSON.stringify(configuredBuildVersion ?? buildVersion()),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
