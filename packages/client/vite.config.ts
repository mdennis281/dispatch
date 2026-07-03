import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite config for the claude-manager SPA.
 * - Dev server proxies /api (REST) and /ws (WebSocket) to the Fastify backend on
 *   127.0.0.1:4319, so the client talks to the real server in dev without CORS.
 * - Build output goes to ./dist, which @cm/server serves as ../client/dist.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4320,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4319",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:4319",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
