# Running claude-manager

A local control plane for Claude Code agents. Runs entirely on your machine and uses your
**Claude subscription** (no API key). All state lives in `./.data` (JSON/JSONL, git-ignored).

## Prerequisites
- Node ≥ 20, pnpm, git, `gh` (authenticated), Docker (only for subApps that need it).
- Logged in to Claude Code (`claude`) — the Agent SDK reuses that subscription.

## Use it (single port — simplest)
```
pnpm -C claude-manager install      # first time only
pnpm -C claude-manager build
pnpm -C claude-manager start
```
Open **http://127.0.0.1:4319**

## Develop it (hot reload)
```
pnpm -C claude-manager dev
```
Open **http://127.0.0.1:4319** — same URL as prod. In dev the server runs Vite in
middleware mode, so the SPA, REST, WebSocket, and HMR are all on one port and one
process. No separate client server, no second port to open.

## First steps in the UI
1. **Project** — pick or add one (a git repo + its subApps). *Hivebreak is pre-seeded.*
2. **New chat** → *(optional)* **Create worktree** — do this **before the first message** so
   the agent is isolated to that worktree (a session started without one runs in the main
   checkout, and can't retro-bind — you'll get a warning if you add a worktree late).
   Rename a chat any time from its title; the usage meter (top bar) tracks tokens/cost.
3. **Message Claude.** Approve/deny tool permissions inline; the **Attention** badge (top bar)
   aggregates "needs input" across every chat. Run 3+ chats at once — it's a workhorse.
4. **Right panel:** worktree diff-vs-main, subApp **Runner** (see below), **Ports & processes**,
   and **PRs + GitHub Actions** (ship / merge / label / rerun / dispatch).
5. **Roll back** any message (hover it) to restore code + conversation to that point.

## Dev-mode processes (subApps)

A **subApp** is any runnable process in a project's repo — a dev server, a game client,
a docker stack, a tool. claude-manager launches them per branch so you can run the app the
agent is working on, right beside the chat, without leaving the UI.

### Declaring subApps
SubApps come from one of two places:
- A committable **`.claude-manager/project.yaml`** manifest at the repo root (the source of
  truth — see `packages/shared/src/project-config.ts` for the full schema), or
- The project record itself (editable in the UI; the pre-seeded Hivebreak project in
  `packages/server/src/seed.ts` is a working example).

Each subApp declares:

| Field | Meaning |
|---|---|
| `id` / `name` | stable id + display name |
| `cwd` (`path`) | dir to run in, relative to the repo root |
| `dev` | the command to spin up the dev process (e.g. `pnpm dev`) |
| `install` / `build` / `test` | optional lifecycle commands |
| `ports` | base port(s) the app wants (e.g. `[5173, 2567]`) |
| `env` | extra env for the dev process; `{port}`/`{port2}`… placeholders are substituted from the **allocated** ports |
| `docker` (`dockerCompose`) | a docker-compose file — declare this **instead of** `dev` for a pure docker stack (one `compose up`, no double-start) |
| `url` | open-in-browser URL, with `{port}` substituted (e.g. `http://localhost:{port}`) |

**Ports are offset per launch** so the same subApp can run on many worktrees at once without
colliding. Pass the allocated ports into your app via `env` placeholders (Hivebreak's `game`
does `CLIENT_PORT={port}` / `SERVER_PORT={port2}`) rather than hard-coding the base — the base
is just the starting point the allocator scans up from.

### Launching one
From the right-panel **Runner** (or the left **Sidebar**):
1. Pick a **launch target** with the branch/worktree picker. Three kinds:
   - 🏠 **primary checkout** — the repo's current branch,
   - 📁 **worktree** — an existing worktree, or
   - 🌿 **branch** — a branch with no worktree yet; one is **created on launch**.
2. **Start** the subApp. Watch **live logs** in the runner log window, open its **URL**, and
   **Stop** it when done. A chat's own worktree is preselected as the default target, so
   "run what this agent is building" is one click.

### Ports & processes (orphan reaper)
The runner tracks the processes *it* spawned, but a dev server is usually a grandchild
(`cmd → pnpm → node → vite`), and a server restart or half-killed tree can leave that
grandchild **orphaned** — still holding the port, invisible to the runner, blocking the next
launch. The **Ports & processes** panel is the escape hatch:
- It runs an on-demand OS scan (`netstat`/`lsof`) of everything LISTENING on the project's
  declared + allocated ports.
- Each row is flagged **tracked** (a live runner owns it) or **orphan** (nothing does).
- **Kill orphans** / **Kill all** tree-kills by pid — use this whenever you hit
  "port already in use" but the UI shows nothing running.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `CM_PORT` | `4319` | HTTP + WebSocket port |
| `CM_DATA_DIR` | `./.data` | on-disk state dir |
| `CM_MAX_ACTIVE_SESSIONS` | `6` | max concurrently-active chats |

Projects, agents, modes, and settings are plain files under `.data/` and editable in the UI.
SubApp definitions live on the project (or its `.claude-manager/project.yaml`) — adjust the run
commands and ports per repo.

## Tests
```
pnpm -C claude-manager test
```
