/**
 * Production entrypoint (`node dist/index.js`). Serves the prebuilt SPA from
 * ../client/dist. For the single-port dev server with HMR, see dev.ts.
 */
import { start } from "./start.js";

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[claude-manager] failed to start:", err);
  process.exit(1);
});
