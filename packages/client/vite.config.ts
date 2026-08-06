import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite config for the Dispatch SPA.
 * - In dev, @dispatch/server runs Vite in middleware mode and serves this SPA + HMR on
 *   its own port (4319), so /api and /ws are same-origin — no proxy needed. See
 *   packages/server/src/dev-vite.ts.
 * - Build output goes to ./dist, which @dispatch/server serves as ../client/dist in prod.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
