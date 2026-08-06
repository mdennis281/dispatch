# Headless verification harness

Fast, **tab-free** UI verification for Dispatch. It drives the
**already-running** server with headless Chromium and writes labeled PNG
screenshots to disk — no real Chrome, no stolen tabs, no auth.

This is for the PM (Claude) to _look_ at the UI. It never starts/stops the
server; it just points a browser at it. (For a hermetic, self-booting end-to-end
test, see `packages/client/e2e/shell-live.spec.ts` instead.)

## Run it

The server must already be running (default `http://127.0.0.1:4319` — `pnpm start`).

```bash
# from repo root
node tools/verify/shot.mjs --flow app                 # load + screenshot the shell
node tools/verify/shot.mjs --flow chat                # first chat: transcript + right panel
node tools/verify/shot.mjs --flow panels              # cycle every RightPanel tab, shot each
node tools/verify/shot.mjs --flow all                 # every flow

# or via the workspace script
pnpm verify --flow all

# override base URL / output dir / scale
node tools/verify/shot.mjs --base http://127.0.0.1:4319 --out .verify-shots --flow panels --scale 2
```

Flags: `--base <url>` (default `http://127.0.0.1:4319`), `--out <dir>` (default
`<repoRoot>/.verify-shots`, gitignored), `--flow app|chat|panels|all` (default
`app`), `--scale <n>` (device scale factor, default `2`). `--help` prints usage.

PNGs land in the output dir, numbered `NN-<label>.png` (e.g. `01-app-loaded.png`,
`02-panel-worktrees.png`). Every saved path + byte size is printed. If the server
isn't reachable the run fails loudly with the base URL — it does **not** fake
success.

If Chromium isn't installed yet:

```bash
pnpm --filter @dispatch/client exec playwright install chromium   # idempotent; installs a browser BINARY, not an npm dep
```

## Add a flow

Flows are data-driven in `tools/verify/shot.mjs` (`FLOWS`). Each is a short
`async (ctx) => {}` using the helpers from `lib.mjs`:

```js
const FLOWS = {
  async settings(ctx) {
    await gotoApp(ctx.page, ctx.base);
    await ctx.page.getByRole("button", { name: "Settings" }).click();
    await ctx.page.waitForTimeout(300);
    await ctx.shot("settings-open");
  },
  // …existing flows…
};
```

`ctx` = the harness from `createHarness`: `{ page, shot, base, dir, saved, … }`.
`shot(name, opts?)` writes a numbered PNG and forwards `opts` to
`page.screenshot` (e.g. `{ fullPage: true }`, `{ clip }`). Prefer role/text/
`data-testid` selectors over CSS classes.

## Smoke test

`packages/client/e2e/verify-smoke.spec.ts` is a read-only Playwright smoke that
asserts the shell renders + hydrates against the running server (skips if none):

```bash
DISPATCH_VERIFY_BASE=http://127.0.0.1:4319 pnpm --filter @dispatch/client exec playwright test verify-smoke
```

## Pointing at the user's REAL Chrome (auth-bearing sites)

The default path is headless + localhost, which needs **no auth**. You only need
real Chrome if you must reuse the user's logged-in cookies/session for an
external, authenticated site. Two approaches:

### A. Attach over CDP (`connectOverCDP`)

Start Chrome with remote debugging, then attach to that live process (reuses its
open tabs, cookies, and logged-in sessions):

```bash
# Windows — start Chrome with a debugging port (use a dedicated profile dir so it
# doesn't clash with a already-running Chrome):
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="C:/Users/Michael/.cache/cm-chrome-debug"
```

```js
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];         // the live profile (its cookies/auth)
const page = context.pages()[0] ?? (await context.newPage());
// …drive + screenshot as usual…
```

### B. Persistent profile (`launchPersistentContext`)

Launch a headed Chrome against a persistent user-data dir; log in once and the
cookies persist across runs:

```js
import { chromium } from "@playwright/test";
const context = await chromium.launchPersistentContext(
  "C:/Users/Michael/.cache/cm-chrome-profile",
  { headless: false, channel: "chrome" },      // real Chrome, visible for first-time login
);
const page = await context.newPage();
```

Both are opt-in escape hatches. For verifying Dispatch itself, stay on the
default headless path — it's faster and never touches the user's browser.
