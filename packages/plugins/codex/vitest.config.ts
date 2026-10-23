import { defineConfig } from "vitest/config";

// Sources only: the build emits into `server/`, and a stale compiled copy must
// never run as a second, outdated suite.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["server/**", "node_modules/**"] },
});
