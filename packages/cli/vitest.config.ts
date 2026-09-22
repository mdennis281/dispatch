import { defineConfig } from "vitest/config";

/**
 * A test budget that survives a contended runner.
 *
 * This package had NO config at all, so it ran on Vitest's 5s default while the
 * server's suite sat at 60s — and the 5s leg is the one that failed a release.
 * `release.yml` run 35568610811 (2026-09-21) died on `auth.test.ts > rehashes
 * the owner password, clears TOTP, and revokes every session`: "Test timed out
 * in 5000ms". Nothing was wrong with it. That case does two argon2id operations
 * at OWASP parameters (memoryCost 19456, timeCost 3) and MEASURES AT 53ms — the
 * whole 54-case suite is 387ms of test time. It overran its budget by ~94x
 * because the single self-hosted runner was starved, in the same window a CI
 * rerun on that box executed zero steps and died at its 10-minute cap.
 *
 * 30s is therefore ~566x headroom over the slowest case, and still catches a
 * genuine hang far inside the job's 30-minute cap. It is half the server's 60s
 * deliberately: that number was set against an 8.5s slowest case, and this
 * one's is 160x smaller.
 *
 * A retry policy was the other candidate and was NOT taken. This failure was a
 * fixed-cost test handed an unrealistic budget, which a budget fixes exactly;
 * a retry would instead teach the gate to swallow the one thing it exists to
 * report — a test that fails intermittently because the CODE is wrong. The
 * server config already made this call ("the 5s default fails tests that are
 * merely slow rather than broken"); this file follows it.
 *
 * No `include`/`exclude` here, unlike the server's config. That one exists to
 * stop Vitest collecting the compiled `dist/**\/*.test.js` twin, which only
 * exists because the server's tsconfig compiles its test files. This package's
 * tsconfig already excludes `src/**\/*.test.ts` from the build, so `dist` has no
 * test files to collect and the guard would be inert — verified by running the
 * suite with this file removed and getting the same 3 files / 54 tests.
 *
 * If you raise this again, measure first and update the number above —
 * `npx vitest run --reporter=verbose` prints per-test ms.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
