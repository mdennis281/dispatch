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

1. Add a server-side release client with ETag caching, timeouts, anonymous-rate
   handling, stable/prerelease channels, and semantic-version comparison.
2. Check at startup and then at a bounded interval; never block app startup on
   GitHub availability.
3. Surface the current version, newest version, release notes, and last check in
   Settings. Offer Download, Install on restart, Skip version, and Remind later.
4. Run the release installer out-of-process so it survives the server's graceful
   shutdown. Stream machine-readable phase updates into the UI.
5. Preserve the current payload until the new server passes `/api/health`; roll
   back automatically on extraction, dependency, launch, or readiness failure.
6. Support an admin policy for automatic checks and automatic installation, with
   metered-network and active-session safeguards.

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
