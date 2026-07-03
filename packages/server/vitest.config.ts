import { defineConfig } from "vitest/config";

/**
 * Scope test discovery to the TypeScript SOURCES only.
 *
 * The build compiles `src/**` (including `*.test.ts`) into `dist/`, so Vitest's
 * default glob would ALSO pick up the compiled `dist/**\/*.test.js` — double-
 * running every suite against a STALE build artifact. That made `vitest run`
 * non-deterministic: a fix in `src/` passed while its stale `dist/` twin still
 * flaked (e.g. an unhandled rejection from the pre-fix `bus.js`). Restricting
 * discovery to `src/` makes the run reproducible regardless of dist's state.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "spikes/**"],
  },
});
