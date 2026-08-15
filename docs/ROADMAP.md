# Product roadmap

The repository and release-install foundation is in place. The next two phases
turn first launch and upgrades into product surfaces instead of shell knowledge.

## Phase 1: first-run setup

Build one setup model used by both a terminal wizard and the UI. Persist a
versioned setup record under the shared config directory so either surface can
resume an interrupted setup and Settings can edit every choice later.

Questions and checks:

1. Detect Node, Python, Git, GitHub CLI, Claude Code, and Codex; show actionable
   fixes without asking for provider credentials.
2. Choose launch-at-login. Implement native adapters for Windows Startup,
   macOS LaunchAgents, and Linux systemd user services, all idempotent and
   removable from Settings.
3. Choose local-only or host mode. Default to local-only. Host mode must show the
   no-auth risk, identify reachable interfaces, and require explicit consent.
4. Choose whether to create a Start-menu/Desktop/PATH launcher and install the
   browser PWA.
5. Configure notifications, session limits, preferred provider, and an initial
   project. Skip remains available for nonessential choices.
6. Finish with a diagnostic summary and a reversible configuration preview.

Implementation shape:

- Shared schema and migrations in `packages/shared`.
- Setup service and `/api/setup` routes in `packages/server`.
- Resumable wizard in `packages/client`; terminal adapter under `tools/setup`.
- Platform services behind a small interface with unit tests and disposable-root
  integration tests. Never test against the developer's real startup entries.

Acceptance criteria:

- A clean install reaches a working first project without editing a file.
- Cancelling at any step resumes safely.
- Every choice is visible and editable later in Settings.
- Re-running setup is idempotent and never duplicates startup entries.

## Phase 2: release update system

Use GitHub Releases as the only production update channel. The existing bootstrap
and release artifact format remain the install engine; the app adds discovery,
policy, and progress around them.

1. **Done.** Server-side release client with ETag caching, timeouts and
   rate-limit handling, falling back to the `gh` CLI while the repo is private
   (`packages/server/src/services/release.ts`). Build stamps are compared by
   `compareBuildVersions`; an unorderable tag pair reads as "no update" rather
   than guessing. Stable/prerelease channels are still outstanding — a draft or
   prerelease is currently ignored, as the installer would refuse it anyway.
2. **Done.** A deferred first check plus an unref'd interval, so GitHub being
   unreachable delays nothing at startup.
3. **Done.** A dismissable card (per-version, so the next release nudges again)
   and a Settings row carrying the running build, the newest build and the last
   check time, with a manual check. Release notes are still outstanding, as are
   the Download / Install-on-restart split.
4. **Done** for the out-of-process part
   (`packages/server/src/services/update-install.ts`): the installer is spawned
   detached, from outside `app/`, with its output captured to `update.log`.
   Machine-readable phase streaming is still outstanding — the client watches
   `/api/health` for the restart instead.
5. Already the installer's behaviour (`tools/install.mjs`), unchanged by this
   work: the previous payload is kept and restored on any post-swap failure.
6. Outstanding. No admin policy, no automatic installation, and no metered-network
   or active-session safeguards.

Acceptance criteria:

- Offline and GitHub-rate-limited checks degrade silently and retain the last
  known result.
- An update never touches `data/` or `config/`.
- A failed update restores the previous healthy payload and explains why.
- Windows, macOS, and Linux exercise install, update, rollback, and interrupted
  recovery in CI or disposable virtual machines.

## Before the first public release

- Choose and add an open-source license; this requires an explicit owner decision.
- Publish a semver tag such as `v0.1.0` and smoke-test both bootstrap commands
  against the generated release asset.
- Replace the outdated product capture with a curated, redacted Dispatch screenshot
  under `docs/assets/`.
- Enable GitHub private vulnerability reporting and repository secret scanning.
