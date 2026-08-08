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

## `.data` is per-instance. Do not point two processes at one.

`runners.json` and `checkpoints.json` are whole-file read-modify-write maps
guarded by an **in-process** mutex. Two processes sharing them silently drop each
other's writes — you lose rollback points with no error. That is the entire
reason `data/` is split while `config/` is shared, and why
`tools/app/backsync.mjs` copies chats rather than pointing dev at prod's dir.

## Publishing vs upgrading.

- `pnpm app:publish` builds **in place** and therefore **refuses to run while the
  app is up**. Stop it first.
- `node tools/app/upgrade.mjs` is the one that may run under a live app: it builds
  in `staging/`, then hands off to a **detached** process to stop/swap/restart/
  health-check, because stopping the server tree-kills every subApp — including
  an upgrade launched from inside Dispatch.

Both publish the **committed** sha. A dirty tree is warned about, never included.

## Spawning `pnpm` from Node needs `shell: true`.

It is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix Node refuses to
spawn a `.cmd` without a shell (EINVAL). `git` is a real executable and must not
get one. See `needsShell` in `tools/app/build-payload.mjs`.

## Tests

`pnpm test` runs **shared + cli + server** only. The client has its own vitest and
playwright suites (`pnpm --filter @dispatch/client test` / `e2e`) that the root
script deliberately does not run — don't assume green means the SPA is tested.

## Comments here explain WHY.

The existing code comments cite the specific failure that motivated the code —
the stale `tsbuildinfo` that skipped emit, the 270MB of Electron left in a
hollowed-out package dir. Match that. A comment restating what the line does is
noise; a comment naming the bug it prevents is why this codebase is maintainable.
