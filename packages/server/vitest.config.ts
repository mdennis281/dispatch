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
     * they were failing.
     *
     * RAISED 30s -> 60s when CI was added, on a measurement rather than a hunch.
     * The slowest single case on the author's box is
     * `app.test.ts > buildApp > registers plugins and serves a green
     * GET /api/health` at 8.5s (the next, "reports 503 + degraded when the SPA
     * shell is missing", is 8.0s) — so 30s was ~3.5x headroom, not the ~7x the
     * old "(~4s)" note here implied. That is thin on a shared `windows-latest`
     * runner, which is slower than this box and contended besides. A flaky gate
     * is worse than no gate: it teaches everyone to ignore the badge. 60s still
     * catches a genuine hang well inside the job's 30-minute cap.
     *
     * If you raise this again, measure first and update the number above —
     * `npx vitest run src/app.test.ts --reporter=verbose` prints per-test ms.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
