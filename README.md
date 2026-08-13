# Dispatch

[![CI](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml)

I built this to get the most out of my AI subscriptions. Im not saying it's the best agent CLI harness out there, but it's the best for how I build projects.

## What it does

- Runs concurrent, steerable agent chats with all the bells and whistles you've grown used to.
- Supports custom, project-level MCPs, Skills, Modes, Agents & Instructions.
- Cutting-edge chat interface.
- Robust, per-project memory system.
- Elegant Github integration with various CICD workflow presets (worktrees recommended).
- AI assisted project-level custom MCP builder

## Install the latest release

Prerequisites: Node.js 20+, Python 3.10+, and at least one authenticated agent CLI
(`claude` or `codex`). Git and GitHub CLI are needed for Git/PR features, but a
Git clone of Dispatch is not.

Windows PowerShell:

```powershell
irm https://github.com/mdennis281/dispatch/releases/latest/download/install.ps1 | iex
```

macOS or Linux:

```sh
curl -fsSL https://github.com/mdennis281/dispatch/releases/latest/download/install.sh | sh
```

The bootstrap downloads the latest GitHub Release, verifies its SHA-256 checksum,
installs runtime dependencies, and starts Dispatch at
`http://127.0.0.1:4318`. Run the same command again to update. Existing chats and
configuration live outside the app payload and survive updates.

Every successful build of `main` is automatically tagged and published using the
UTC build version displayed in the app (`vyyyy.mm.dd.sssss`). Re-running the
release workflow for the same commit safely refreshes that release's assets.

Use `--version v2026.08.13.12345`, `--no-start`, `--no-shortcut`, or
`--target <path>` when running a downloaded copy of the script. Set
`GITHUB_TOKEN` while the repository is private.

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
