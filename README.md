# Dispatch

[![CI](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/mdennis281/dispatch/actions/workflows/ci.yml)

An all-in-one agent CLI harness that replaces how you work with your LLMs. I built this to get the most out of my AI subscriptions. Im not saying it's the best agent CLI harness out there, but it's the best for how I build projects.

<img width="953" height="765" alt="image" src="https://github.com/user-attachments/assets/01e324d2-4546-4d65-ba44-199c8402ec1e" />
<details>
  <summary>More screenshots</summary>
  
  <img width="439" height="456" alt="image" src="https://github.com/user-attachments/assets/8af282d9-81ff-425b-9de6-b1381c4fe84a" />
  <img width="306" height="251" alt="image" src="https://github.com/user-attachments/assets/fa8936fe-cc54-43cb-8dd5-57dc550c1cc7" />
  
  <img width="872" height="646" alt="image" src="https://github.com/user-attachments/assets/2e9d3cc4-15b4-4080-9a99-b5ea494e7c21" />
  <img width="889" height="735" alt="image" src="https://github.com/user-attachments/assets/d08c46e3-aa96-40f1-8606-047ba90c6504" />
  <img width="1093" height="742" alt="image" src="https://github.com/user-attachments/assets/5dae773d-0720-4c0e-a0eb-9494ce658c4d" />
  <img width="885" height="662" alt="image" src="https://github.com/user-attachments/assets/ab5354bc-71ca-4cf3-bb43-01c928dafed0" />
  <img width="369" height="544" alt="image" src="https://github.com/user-attachments/assets/1b77c8a5-f618-41c1-b9a3-329b0f319e03" />
  <img width="497" height="737" alt="image" src="https://github.com/user-attachments/assets/2a32b24e-7201-48f9-8ac0-42c823fafc00" />
    
</details>

## What it does

- Concurrent, steerable agent chats across your authenticated agent CLIs.
- Per-project MCP servers, skills, modes, agents and instructions — authored by
  hand or by the agent itself. Three scopes: committed in the repo, global to
  your machine, or shipped with Dispatch (most specific wins).
- A `/` command menu over every skill and built-in the session can actually run.
- Per-project memory.
- GitHub integration with worktree/PR workflow presets.
- AI-assisted builder for project-level MCP servers.

## Install

Prerequisites: Node.js 24+, Python 3.10+, and at least one authenticated agent
CLI (`claude` or `codex`). Git and the GitHub CLI are needed for Git/PR features.

Windows PowerShell:

```powershell
irm https://github.com/mdennis281/dispatch/releases/latest/download/install.ps1 | iex
```

macOS or Linux:

```sh
curl -fsSL https://github.com/mdennis281/dispatch/releases/latest/download/install.sh | sh
```

This downloads the latest release, verifies its checksum, installs dependencies,
registers Dispatch to start at login, and serves it at `http://127.0.0.1:4318`
(also reachable at `http://<lan-ip>:4318`). Run the same command again to update;
chats and configuration live outside the app payload and survive updates. An
installed Dispatch also offers updates from inside the app, under Settings.

Flags: `--version <tag>`, `--no-start`, `--no-open`, `--no-shortcut`,
`--no-autostart`, `--target <path>`. See
[RUNNING.md](./RUNNING.md#install) for the operator guide — autostart per
platform, host mode, and the one-time store migration required when upgrading
from a build older than `data/state.db`.

## Develop from source

```sh
git clone https://github.com/mdennis281/dispatch.git
cd dispatch
corepack pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm dev
```

The dev server uses `http://127.0.0.1:4319`, so it runs beside an installed
release on 4318. See [RUNNING.md](./RUNNING.md) for the full developer guide.

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

Development and direct server launches bind to loopback; the installed launcher
uses host mode for LAN access. Authentication is optional and off by default —
enable it in Settings before exposing the app outside a trusted network. See
[SECURITY.md](./SECURITY.md).
