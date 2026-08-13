# Dispatch

[![CI](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml)

Dispatch is a local control plane for running Claude Code and Codex across
multiple repositories, chats, worktrees, and pull requests. It keeps the work
on your machine while giving long-running coding agents a focused desktop UI.

## What it does

- Runs concurrent, steerable agent chats with inline permissions and questions.
- Creates isolated Git worktrees and tracks each chat's changes and processes.
- Shows diffs, terminals, sub-apps, pull requests, CI, and review state together.
- Supports project-scoped agents, skills, MCP servers, workflow policy, and memory.
- Stores chats and configuration locally; provider authentication stays in the
  provider's own CLI credential store.

## Install the latest release

Prerequisites: Node.js 20+, Python 3, and at least one authenticated agent CLI
(`claude` or `codex`). Git and GitHub CLI are needed for Git/PR features, but a
Git clone of Dispatch is not.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/mdennis281/dispatch/main/install.ps1 | iex
```

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mdennis281/dispatch/main/install.sh | sh
```

The bootstrap downloads the latest GitHub Release, verifies its SHA-256 checksum,
installs runtime dependencies, and starts Dispatch at
`http://127.0.0.1:4318`. Run the same command again to update. Existing chats and
configuration live outside the app payload and survive updates.

Use `--version v1.2.3`, `--no-start`, `--no-shortcut`, or `--target <path>` when
running a downloaded copy of the script. Set `GITHUB_TOKEN` while the repository
is private.

## Develop from source

```sh
git clone https://github.com/mdennis281/dispatch.git
cd dispatch
corepack pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm dev
```

The development server uses `http://127.0.0.1:4319`, so it can run beside the
installed release on port 4318. See [RUNNING.md](./RUNNING.md) for the full
developer and operator guide.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/client` | React/Vite desktop PWA |
| `packages/server` | Fastify API, agent runtimes, Git/worktree orchestration |
| `packages/shared` | Shared schemas and wire/domain types |
| `packages/cli` | Project configuration CLI |
| `tools/app` | Installed-app launcher and developer publishing tools |
| `tools/release` | Reproducible GitHub Release packaging |

## Security

Dispatch binds to loopback by default. Host mode (`DISPATCH_HOST=0.0.0.0`) has no
application authentication and should only be used on a trusted network. See
[SECURITY.md](./SECURITY.md) for credential handling and reporting guidance.

The onboarding and in-app release update work is mapped in
[docs/ROADMAP.md](./docs/ROADMAP.md).
