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
6. **Source Control** (left sidebar, under Memory) — the working copy for the project
   checkout **or any of its worktrees** (pick with the repo selector). See [Source
   control](#source-control) below.

## Source control

The **Source Control** view is a full git client over one repo directory at a time. Pick
the project checkout or any worktree from the repo selector — everything below re-scopes
to it, so you can review what an agent did in its worktree without leaving the app.

| Tab | What it does |
|---|---|
| **Changes** | Staged / Changes / Untracked groups. Stage, unstage or discard per file (or all); click any row for a Monaco diff of that side of the index. Conflicts get their own group. |
| **History** | Commits newest-first; expand one for its files (+/− counts), click a file to diff it against the commit's parent. |
| **Stashes** | The stash stack with Apply / Pop / Drop, and per-entry file lists you can diff before restoring. |

Also in the toolbar: **branch switcher** (search, switch, create — a branch checked out in
another worktree is disabled, since git refuses a second checkout), **Stash**, and
**Fetch / Pull / Push** with the ahead/behind counts. Pushing a branch with no upstream
publishes it (`--set-upstream`).

**Commit message (AI)** — the ✨ button on the message box drafts one from the *staged*
diff via a one-shot `claude-haiku-4-5` call, matching the style of your recent commits.
It lands in the box for you to edit; ⌘/Ctrl+Enter commits. **Amend** rewrites the tip.

Two actions are irreversible and take a second click to confirm: **discard** (reverts
tracked files, deletes untracked ones) and **drop stash**. Git never prompts for
credentials here — a push that needs auth fails fast with the reason instead of hanging.

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

## MCP servers (`cm mcp`)

A managed repo's MCP servers live in its committable `.claude-manager/project.yaml`.
The manager watches that file, so an edit applies to the next turn — no restart.

Three ways to add one, all writing the same file:

- **Ask an agent.** Sessions get `mcp__manager__mcp_add` / `mcp_list` / `mcp_remove`,
  plus a bundled `mcp-setup` skill that fires whenever the conversation turns to
  installing or debugging an MCP server.
- **The `cm` CLI**, from anywhere inside the repo.
- **By hand**, if you prefer — the CLI just validates for you.

```bash
cm mcp add ripgrep -- npx -y mcp-ripgrep@latest      # stdio (local subprocess)
cm mcp add linear --transport http --url https://mcp.linear.app/mcp
cm mcp add-json foo '{"command":"npx","args":["-y","foo-mcp"]}'
cm mcp import ./.mcp.json                            # bulk import
cm mcp list | get <name> | remove <name>
```

`cm` needs `pnpm build` once, then to reach it from a managed repo put it on your
PATH:

```bash
npm i -g ./packages/cli        # from the claude-manager checkout
```

Without installing, run it from the claude-manager checkout with an explicit
target directory:

```bash
pnpm cm mcp list -C /path/to/your/repo
```

**Secrets stay out of the committed file.** Values may use `${VAR}` or
`${VAR:-default}`, expanded from the manager process's environment when a session
starts:

```bash
cm mcp add linear --transport http --url https://mcp.linear.app/mcp \
  -H "Authorization: Bearer ${LINEAR_API_KEY}"
```

An unset variable expands to an empty string and shows up as a project-config
warning rather than breaking the project.

Open the **MCP catalog** in the UI (top bar / command palette) to see every
configured server's live connection status and its tools, command by command,
grouped by server.

## Desktop app (stable) vs `pnpm dev` (unstable)

Two instances, on purpose: an **installed Electron app** you can trust with long-running
agents, and the **hot-reload dev server** you break things in. They run side by side.

| | Stable | Dev |
|---|---|---|
| Launch | Start-menu shortcut / `pnpm desktop` | `pnpm dev` |
| Port | **4318** (scans up if taken) | **4319** |
| Code | published payload in `%LOCALAPPDATA%` | this checkout, hot-reloaded |
| Updated by | the *Publish to stable* VS Code task | saving a file |

### Layout
```
%LOCALAPPDATA%\claude-manager\
  app\            the payload — a git clone of this repo, built in place
  shell\          branded Electron runtime: claude-manager.exe + resources
  data\           CM_DATA_DIR   chats, checkpoints, runners   (per-instance)
  config\         CM_CONFIG_DIR settings, projects, agents, modes (SHARED)
  current.json    published sha + timestamp (shown in the tray tooltip)
  runtime.json    present only while the app is running
```

### Why there's a `shell\` with its own .exe
Windows identifies a pinned taskbar item by the **target executable**, not by the
shortcut's icon. Launch `node_modules/electron/dist/electron.exe` and Windows pins
*Electron* — so the icon "reverts" the instant you pin it, and nothing you set on the
`.lnk` can override it. `install-shell.mjs` copies Electron's `dist/` to `shell\`,
renames the binary to `claude-manager.exe`, and stamps the icon and version strings in
with rcedit. It copies rather than renaming in place because `node_modules/electron`
lives in pnpm's content-addressed store, shared with every other project on the machine.

Re-run it only when Electron itself is upgraded (`pnpm desktop:install-shell`; it's a
no-op otherwise). The icon is generated — PNG for the window/tray, multi-size `.ico` for
the shortcut and the exe resource — by `pnpm --filter @cm/desktop icon`, which the
desktop build runs automatically.

**`config/` is shared, `data/` is not** — and that split is deliberate. Projects, agents
and modes are written rarely and are miserable to maintain twice, so both instances read
one copy. Chats are the opposite: `checkpoints.json` and `runners.json` are whole-file
read-modify-write maps guarded by an *in-process* mutex, so two processes sharing them
would silently drop each other's entries. Losing rollback points on the instance you
trust with long work isn't a tradeoff worth making, so each instance keeps its own chats.
Want to see stable's chats while working in dev? Open both tabs.

### Install
```
node tools/desktop/migrate-data.mjs --dry-run   # preview; then drop --dry-run
pnpm desktop:install-shell                      # branded claude-manager.exe (~270 MB, once)
pnpm desktop:publish                            # build + install the payload
pnpm desktop:shortcut                           # Start-menu entry (add -- --desktop)
```
The shortcut resolves the real Start-menu / Desktop folders from Windows rather than
assuming `%USERPROFILE%\Desktop`, which OneDrive redirects.
The migration **copies** — it verifies every file by SHA-256 and never deletes or
modifies the source `.data`. Re-running it refuses a non-empty destination unless
`--force`.

### Updating
Run the **claude-manager: Publish to stable** VS Code task (or `pnpm desktop:publish`).
It publishes the **committed** `HEAD` — a dirty working tree is reported loudly and
*not* included, because a "stable" build you can't reproduce from git isn't stable. If
the build fails it rolls the payload back to the previous sha and rebuilds it.

It **refuses to run while the app is open.** Quit from the tray first — *Quit (stops all
agents & subApps)* — which tears down cleanly; killing the window does not.

### Process ownership
Everything is a descendant of the Electron shell: it spawns the server under a real
`node` (not Electron's own binary, which would confuse anything resolving
`process.execPath`), and the server owns every SDK session and subApp. Quitting asks the
server to shut down over **stdin** — Windows can't deliver `SIGTERM` — waits for
`runner.stopAll()`, then tree-kills whatever is left. If the shell dies abruptly, the
server notices its stdin close and tears itself down rather than orphaning subApps.

Closing the window **hides to tray**; only the tray's Quit stops anything. A reflex
Alt-F4 must not kill a three-hour run.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `CM_PORT` | `4319` (desktop: `4318`) | HTTP + WebSocket port |
| `CM_DATA_DIR` | `./.data` | state dir — chats, checkpoints, runners |
| `CM_CONFIG_DIR` | = `CM_DATA_DIR` | config dir — settings, projects, agents, modes |
| `CM_MAX_ACTIVE_SESSIONS` | `6` | max concurrently-active chats |
| `CM_APP_DIR` | installed payload | run the shell against a different checkout |
| `CM_HOME` | `%LOCALAPPDATA%\claude-manager` | root for the whole installed layout |

Leaving `CM_CONFIG_DIR` unset gives the original single-root layout, byte for byte.

Projects, agents, modes, and settings are plain files under `.data/` and editable in the UI.
SubApp definitions live on the project (or its `.claude-manager/project.yaml`) — adjust the run
commands and ports per repo.

## Tests
```
pnpm -C claude-manager test
```
