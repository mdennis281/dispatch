---
name: upgrade-the-app
description: Ship a new build to the installed (stable) Dispatch instance, and recover when a swap is interrupted. Use when asked to update, upgrade, publish, or roll back the stable app, or when the app won't start and `app/` looks wrong.
---

# Upgrading the stable instance

Two tools, and picking the wrong one is the mistake worth avoiding.

| | `pnpm app:publish` | `pnpm app:upgrade` |
|---|---|---|
| App may be running | **No** — refuses | **Yes** |
| Builds | in place, in `app/` | in `staging/`, then renames it in |
| Downtime | the whole build | one directory rename |
| Rollback | rebuilds the previous sha (can fail again) | renames the old payload back (cannot) |

Both publish the **committed** sha. A dirty tree is warned about, never included.

## First time on a given install: bootstrap

`app:upgrade`'s health gate proves the new process replaced the old one by
comparing `pid` and `startedAt` from `/api/health`. A payload built before
`packages/server/src/health.ts` existed answers a flat `{"ok":true}` and reports
neither, so the gate can never pass.

The tool detects this and refuses **before moving anything**. If you see
*"the installed payload predates the readiness probe"*, do this once:

```
pnpm app:stop
pnpm app:publish
```

Every upgrade after that can run under the live app.

## The normal path

```
pnpm app:upgrade                  # stage HEAD, then swap it in
pnpm app:upgrade -- --ref v1.2    # a different commit
pnpm app:upgrade -- --dry-run     # say what it would do
pnpm app:upgrade -- --stage-only  # build staging/, don't swap
```

It returns to your prompt almost immediately after the build, because the
destructive half runs **detached** — stopping Dispatch tree-kills every process
the runner spawned, and an upgrade launched from inside Dispatch is one of them.
The detached half has no console.

**Watch it with `pnpm app:upgrade -- --status`**, not by staring at the terminal.
That reads `upgrade.json` and prints a phase plus an explicit remedy. Full
narration is in `upgrade.log` in the deployment root
(`%LOCALAPPDATA%\claude-manager\`).

Once it reports OK, **reload any open tab** — the SPA and its service worker
changed.

## When something goes wrong

Run `--status` first. It tells you the phase and what to do. The phases that
need a human:

- **`aborted`** — nothing moved. The old app is still serving, or was restarted
  and health-checked before this was written. Safe to just re-run.
- **`rolled-back`** — the new build failed its health check and the previous
  payload is serving again. The build that broke is kept under `failed/`; it is
  the only copy, so look at it before deleting.
- **`swapping` / `starting` / `restoring`** with nothing running — the detached
  half was killed mid-move. **This is what `--recover` is for:**

```
pnpm app:upgrade -- --recover
```

It puts the payload back from `backups/`, re-verifies it, and starts it.

- **`STUCK`** — read `upgrade.log`. Both payloads are on disk; nothing is lost.

### Do NOT reach for `app:publish` to fix a broken swap

If `app/` is missing, `app:publish` sees no payload, clones a fresh one, and
cold-builds for ten minutes — silently abandoning the good, already-built
payload sitting in `backups/`. Use `--recover`. The launcher says the same thing
if you click the shortcut in that state.

## What is never at risk

`data/` and `config/` are siblings of `app/`, reached through
`DISPATCH_DATA_DIR` / `DISPATCH_CONFIG_DIR`. Every move the upgrade makes is
confined to `app/`, `staging/`, `backups/` and `failed/`. No chat, checkpoint or
setting is read, written or moved by any of this.

## One backup generation, deliberately

The success path recycles the old payload straight back into `staging/` — it is
already a populated clone, which is what keeps the next build incremental. So
`backups/` normally holds one payload, and the next upgrade overwrites it.
`--keep-backup` opts out, but nothing prunes what accumulates then. This is not
a history; it is the one rename that undoes the last swap.
