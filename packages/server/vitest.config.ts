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
    /**
     * A large slice of this suite drives REAL git repos in temp dirs (worktrees,
     * checkpoints, memory commits, trunk sync). Each of those cases is several
     * `git` subprocesses, and the files run in parallel — so on Windows a case
     * that takes ~600ms alone can take many seconds under full-suite load, and
     * the 5s default fails tests that are merely slow rather than broken. Every
     * one of these suites passes in isolation; the timeout was the only thing
     * they were failing. 30s is far above the observed worst case (~4s) while
     * still catching a genuine hang.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
