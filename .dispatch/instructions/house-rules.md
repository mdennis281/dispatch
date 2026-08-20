# Working on Dispatch

Things about this repo that are easy to get wrong and expensive to get wrong.

## There are two instances. Know which one you are looking at.

- **Stable** — the installed PWA. Port **4318**. Code is the published payload in
  `%LOCALAPPDATA%\claude-manager\app`, a real git clone built in place.
- **Dev** — `pnpm dev`. Port **4319**. Code is this checkout, hot-reloaded.

They run side by side and share `config/` but **not** `data/`. Before claiming a
change works, check which port you actually hit.

## Never `taskkill` the server.

Windows cannot deliver `SIGTERM` — `os.kill(pid, SIGTERM)` maps to
`TerminateProcess`, which runs no handler. The server's teardown
(`services.dispose()` → `runner.stopAll()`) is what kills the subApp dev servers
it spawned, so a hard kill orphans every one of them onto the port it holds.

Stop it one of these ways only: `pnpm app:stop`, Ctrl-C in a `pnpm dev` window,
or Settings → Stop in the app.

## `.data` is per-instance — by policy now, not by necessity.

It used to be by necessity: `runners.json` and `checkpoints.json` were whole-file
read-modify-write maps guarded by an **in-process** mutex, so two processes
sharing them silently dropped each other's writes and you lost rollback points
with no error.

Those maps are rows in `data/state.db` now, and SQLite + WAL makes concurrent
access correct — writers serialize, readers get a snapshot. The split stays
because a dev crash still shouldn't cost the instance you trust with long work
its rollback points, and because `tools/app/backsync.mjs` exists to move chats
across deliberately. Don't re-argue the split from the mutex; that reason is gone.

Transcripts (`chats/<id>/messages.jsonl`) and assets are still files on purpose.

## Publishing vs upgrading.

- `pnpm app:publish` builds **in place** and therefore **refuses to run while the
  app is up**. Stop it first.
- `node tools/app/upgrade.mjs` is the one that may run under a live app: it builds
  in `staging/`, then hands off to a **detached** process to stop/swap/restart/
  health-check, because stopping the server tree-kills every subApp — including
  an upgrade launched from inside Dispatch.

Both publish the **committed** sha. A dirty tree is warned about, never included.

## Releasing vs promoting. A channel is the prerelease flag.

Neither of the two scripts above is how a build reaches a user. That is GitHub
Releases, and there are two channels:

- **unstable** — `.github/workflows/release.yml`, on every merge to `main`, as a
  `--prerelease`. Nothing gates it beyond the release job's own build/test.
- **stable** — `.github/workflows/promote.yml`, `workflow_dispatch` only. It
  re-runs the full gate against an existing prerelease's sha and then **flips
  that same release** with `gh release edit --prerelease=false --latest`.

It promotes rather than rebuilds so the stable tarball is byte-for-byte the one
that was tested as unstable. Do not "fix" this into a second build — a rebuild
means the stable bits are not the tested bits, and adds a second way for a
release to be half-published.

Consequences worth remembering:

- `releases/latest` IS the stable channel; GitHub excludes prereleases from it
  server-side, so no code has to remember to filter.
- Re-running `release.yml` on an existing tag uploads assets with `--clobber` and
  deliberately does **not** set the prerelease flag — doing so would retract an
  already-promoted release.
- `retention.yml` deletes prereleases past 90 days, keeping the newest 10
  whatever their age. It never touches a non-prerelease.
- The subscription is `AppSettings.updateChannel` in `config/`, which install and
  upgrade never replace. `PUT /api/settings` is a full replace, so it preserves
  that field by hand — exactly as it does for `auth`.

## Spawning `pnpm` from Node needs `shell: true`.

It is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix Node refuses to
spawn a `.cmd` without a shell (EINVAL). `git` is a real executable and must not
get one. See `needsShell` in `tools/app/build-payload.mjs`.

## Tests

`pnpm test` runs **shared + cli + server** only. The client has its own vitest and
playwright suites (`pnpm --filter @dispatch/client test` / `e2e`) that the root
script deliberately does not run — don't assume green means the SPA is tested.

## Verify UI changes by LOOKING at them.

`pnpm test` doesn't run the client suites (above), and nothing in this repo
asserts what a component looks like. A UI change that builds and type-checks has
been verified by nobody.

Both bundled browser MCPs are injected into every chat here — the `dev-server`
sub-app declares a `url`, which is what the `auto` gate reads. So there is no
excuse left:

1. `run_subapp` the dev server, and note the port it ACTUALLY got. It is not
   4319 when another agent already holds that one.
2. `mcp__playwright__browser_navigate` there, then `browser_snapshot` for "is it
   present, does it say the right thing" — an a11y tree, far cheaper than a
   picture — and `browser_take_screenshot` when the question is genuinely visual.
3. `mcp__chrome-devtools__list_console_messages` when it renders but misbehaves.

Screenshots render inline in the transcript, so a capture of the thing working
is worth more than a paragraph asserting that it does.

## Comments here explain WHY.

The existing code comments cite the specific failure that motivated the code —
the stale `tsbuildinfo` that skipped emit, the 270MB of Electron left in a
hollowed-out package dir. Match that. A comment restating what the line does is
noise; a comment naming the bug it prevents is why this codebase is maintainable.
