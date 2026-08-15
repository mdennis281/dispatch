# Dispatch

[![CI](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml)

An all-in-one agent CLI harness that replaces how you work with your LLMs. I built this to get the most out of my AI subscriptions. Im not saying it's the best agent CLI harness out there, but it's the best for how I build projects.

<img width="1273" height="795" alt="image" src="https://github.com/user-attachments/assets/407ecff5-85c2-4d6c-9beb-4bee646e1533" />


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
`http://127.0.0.1:4318` (also reachable at `http://<lan-ip>:4318`). Run the same
command again to update. Existing chats and
configuration live outside the app payload and survive updates.

An installed Dispatch checks for newer releases itself and offers to install one
from a dismissable card; the same offer, plus the running build and a manual
check, lives at the top of Settings. Choosing to update runs this installer
detached, so it survives the shutdown it performs on the way through. A Dispatch
run from a source checkout has no release to compare against and shows none of
this.

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

Development and direct server launches bind to loopback by default; the installed
launcher explicitly uses host mode for LAN access. Optional authentication is off after an
upgrade and can be configured in Settings; enable it before exposing the installed
app outside a trusted network. See
[SECURITY.md](./SECURITY.md) for credential handling and reporting guidance.

The onboarding and in-app release update work is mapped in
[docs/ROADMAP.md](./docs/ROADMAP.md).
