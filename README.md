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

- Runs concurrent, steerable agent chats with all the bells and whistles you've grown used to.
- Supports custom, project-level MCPs, Skills, Modes, Agents & Instructions —
  authored by hand, or by the agent itself through `mcp__dispatch-config__*`.
  Skills and instructions come in three scopes: committed in the repo, global to
  your machine, or shipped with Dispatch (most specific wins).
- Cutting-edge chat interface, with a `/` command menu over every skill and
  built-in the session can actually run.
- Robust, per-project memory system.
- Elegant Github integration with various CICD workflow presets (worktrees recommended).
- AI assisted project-level custom MCP builder

## Install the latest release

Prerequisites: Node.js 24+, Python 3.10+, and at least one authenticated agent CLI
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

It also registers Dispatch to **start when you log in** — a Startup shortcut on
Windows, a LaunchAgent on macOS, a systemd *user* unit (or an XDG autostart
entry) on Linux. That starts the server only; no window opens. Everything is
per-user rather than a machine service, because Dispatch runs your agent CLIs
with your credentials, so on a headless box you want
`loginctl enable-linger $USER` to bring it up at boot rather than at first login.
`--no-autostart` skips it, and removes it if a previous install set it up. See
[RUNNING.md](./RUNNING.md#start-at-login).

**Updating from a build older than the SQLite store:** per-instance state
(checkpoints, PRs, worktrees, runners, terminals) moved out of JSON files into
`data/state.db`, and the server refuses to start on a store that still has the old
files and no *finished* migration rather than migrating it silently behind your back. Stop it,
run `pnpm app:migrate-store -- --source "<your data dir>"`, and start it again. The
old files are copied, never modified, and stay put as the rollback path. See
[RUNNING.md](./RUNNING.md#install) for the full walkthrough.

An installed Dispatch checks for newer releases itself and offers to install one
from a dismissable card; the same offer, plus the running build and a manual
check, lives at the top of Settings. Choosing to update runs this installer
detached, so it survives the shutdown it performs on the way through. A Dispatch
run from a source checkout has no release to compare against and shows none of
this.

Every successful build of `main` is automatically tagged and published using the
UTC build version displayed in the app (`vyyyy.mm.dd.sssss`). Re-running the
release workflow for the same commit safely refreshes that release's assets.

Use `--version v2026.08.13.12345`, `--no-start`, `--no-open`, `--no-shortcut`,
`--no-autostart`, or `--target <path>` when running a downloaded copy of the
script. Set `GITHUB_TOKEN` while the repository is private.

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
