import { defineConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * THE WINDOWS-SENSITIVE SUBSET — the only suites worth paying a real Windows
 * host to run.
 *
 * Every file below either branches on `process.platform` or touches a real
 * filesystem, so Linux cannot prove it: `needsShell` exists for pnpm's `.cmd`
 * shims, `services/processes.ts` parses `netstat`, stop-over-stdin exists
 * because Windows has no SIGTERM, and `store/fsq.ts` retries an
 * EPERM-on-rename that only happens against a Windows filesystem.
 * `fs-explorer.test.ts` is the one that most needs a Windows runner: its pure
 * helpers are platform-parameterized so both OSes' branches run everywhere, but
 * the drive probe, the `Get-Acl` owner lookup and the Recycle Bin path can only
 * be exercised for real here. Everything else in the suite is
 * platform-agnostic and is covered by the Linux gate.
 *
 * WHY THIS LIST IS A FILE AND NOT A WORKFLOW STEP. It used to be an inline
 * `vitest run a.test.ts b.test.ts …` duplicated into both `ci.yml` and
 * `promote.yml`, with a comment telling you to change both. That comment did
 * not work: the copy in `promote.yml` had silently fallen two files behind, so
 * the STABLE gate — the one gate that exists to catch Windows regressions —
 * was skipping `fs-explorer.test.ts` and `harness/acp/index.test.ts`. One list,
 * in one place, run by `pnpm --filter @dispatch/server test:windows`.
 *
 * If you add a test that asserts Windows-specific behaviour, add its file here
 * or it will only ever run on a developer's machine.
 *
 * Spread rather than `mergeConfig`, deliberately: mergeConfig CONCATENATES
 * arrays, so it would keep the base `src/**\/*.test.ts` glob alongside this
 * list and quietly run the whole suite — the exact thing this config exists to
 * avoid. The base's timeouts and `exclude` still come through.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "src/store/store.test.ts",
      "src/services/agent-cwd.test.ts",
      "src/services/runtime.test.ts",
      "src/services/processes.test.ts",
      "src/services/terminal.test.ts",
      "src/services/file-index.test.ts",
      "src/services/runner.test.ts",
      "src/routes/fs.test.ts",
      "src/services/fs-explorer.test.ts",
      "src/services/mcp/manager-mcp.integration.test.ts",
      "src/harness/acp/index.test.ts",
    ],
  },
});
