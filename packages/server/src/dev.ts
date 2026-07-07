/**
 * Dev entrypoint (`tsx watch src/dev.ts`, run by `pnpm dev`). Serves the SPA and
 * HMR via Vite middleware on the API port, so the whole app lives on one URL
 * (http://127.0.0.1:4319) — no separate client dev server.
 */
import { start } from "./start.js";

start({ dev: true }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[claude-manager] failed to start:", err);
  process.exit(1);
});
