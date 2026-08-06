# Running Dispatch

A local control plane for Claude Code agents. Runs entirely on your machine and uses your
**Claude subscription** (no API key). All state lives in `./.data` (JSON/JSONL, git-ignored).

## Prerequisites
- Node ≥ 20, pnpm, git, `gh` (authenticated), Docker (only for subApps that need it).
- Logged in to Claude Code (`claude`) — the Agent SDK reuses that subscription.

## Use it (single port — simplest)
```
pnpm -C dispatch install      # first time only
pnpm -C dispatch build
pnpm -C dispatch start
```
Open **http://127.0.0.1:4319**

## Develop it (hot reload)
```
pnpm -C dispatch dev
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

## Workflow profiles

Every managed repo is a multi-agent repo, but they aren't all at the same stage. A
project's **workflow profile** says how change ships there — and, unlike a CLAUDE.md,
Dispatch both injects it into every session and enforces it.

| Profile | What the agent is told | What's enforced |
|---|---|---|
| **`none`** | Work in the checkout. Don't branch, don't open PRs, don't commit unasked — the human batches commits. | nothing |
| **`commit`** | Same checkout, but finish a task by committing it: small conventional commits, no dirty tree at the end. Still no branches or PRs. | memory writes are committed |
| **`review`** | One task → one worktree → one reviewed PR. Ship, work the CI + review loop with `watch_pr`, let the merge land it — or land it yourself with `approve_pr` when [auto-merge](#workflow-profiles) is on. | `git commit`/`push` targeting the trunk and `gh pr merge` are **refused**; memory committed; trunk fast-forwarded after every merge |

Pick one in **Project config** (the ⚙ view), or — better, since it's then committable —
author it in the repo's `.dispatch/project.yaml`, where it OVERRIDES the UI choice:

```yaml
workflow:
  profile: review
  # every field below is optional; each defaults from the profile
  worktree: pnpm worktree     # custom worktree command
  ship: pnpm ship             # custom ship command
  guard: deny                 # off | warn | deny
  memory: commit              # ignore | commit
  syncMainAfter: merge        # never | ship | merge
  autoMerge: on-green         # off | on-green  — agents land their own PRs
  mergeMethod: squash         # squash | merge | rebase
```

A project with no `workflow:` block keeps behaving exactly as it did before profiles
existed: it resolves to `review` if it has a ship command, else `none`.

**Why memory rides its own lane.** Memory is project-scoped, not branch-scoped, so it is
always written to the **primary checkout** — an agent in a worktree can't carry it in a
PR even in principle. Under `commit`/`review` the manager therefore commits
`.dispatch/memory/` itself, in its own `chore(memory):` commit (pathspec-limited,
so your staged work is never swept in), and pushes when the trunk has an upstream. It
also sweeps at boot, so memory stranded while the manager was down still lands. If your
repo blocks pushes to the trunk, exempt memory-only pushes in the hook — Hivebreak's
`hooks/pre-push` is a worked example.

**Auto-merge (a `review` sub-setting).** By default a `review` project ships the PR and
waits for a human (or the repo's auto-merge job) to land it. Turn **Auto-merge** on — in
Project config under the profile picker, or `autoMerge: on-green` in the manifest — and
the session gets one extra tool, `mcp__manager__approve_pr`, plus an instruction to use
it: once CI is green and no review thread is open, the agent approves and merges its own
PR, and the task is done. Everything the agent does gets pushed forward without you in
the loop.

It is not a blank cheque. `approve_pr` re-reads the PR at the moment it's called and
refuses — listing every reason at once — on a failing or still-running check, an
unresolved review thread, a draft, a conflict, or a `changes_requested` review. Two
stop signals are yours specifically:

- **Say so.** If you asked the agent to leave the PR open, to let you look first, or to
  "just open a PR", it's told to stand down and report the PR as ready instead.
- **The `hold` label.** Parks one PR without turning the feature off project-wide; the
  agent is told not to remove it to get around the block.

A raw `gh pr merge` stays refused either way — `approve_pr` is the only sanctioned path,
because it's what runs those checks, records the approval, and fast-forwards the trunk
afterwards. Projects that leave the toggle off are unchanged: the tool isn't merely
discouraged there, it isn't offered.

## Project config

The **Project config** view (⚙) is where a repo's `.dispatch/` lives: a section rail —
Workflow, Instructions, Agents, Skills, Modes, MCP servers, Sub-apps, Memory — and, for
each, what it's for, what this project has, and how to add to it. Every section but
Workflow is file-backed, so items carry their source file: **Edit** opens it in the
editor, **Delete** removes it, and the `.dispatch/` watcher refreshes the view in place.
MCP servers and sub-apps live inside `project.yaml`, so those point at the manifest
instead.

**Two ways to add.** Write the file yourself, or type what you want into **Add a
&lt;thing&gt;** and hit *Have Claude do it*. That spawns a chat in the project, briefed with
the format rules for that section — where the file goes, what frontmatter it needs, the
house conventions — and told to read the repo before writing, so you get something
specific rather than boilerplate. It's an ordinary chat: it follows the project's workflow
profile (on `review`, that means a worktree and a PR), and you can steer or stop it. The
sidebar row wears the section's icon so you can spot what it's working on.

**Saving.** Workflow edits are a draft behind an explicit **Save** — the footer shows
*Unsaved changes*, closing with edits pending asks first, and **Discard** reverts. When
the repo has a `project.yaml`, Save writes `workflow:` into it (comments and key order
preserved) rather than the `.data` record, because the manifest overrides that record on
every config reload — which is what used to make a UI edit look saved and then quietly
revert.

**Guard.** The trunk guard runs as a `PreToolUse` hook rather than through the permission
prompt, so it still fires under **Bypass** — the posture where an unattended agent is
most likely to reach for `git push origin main`. It reads the branch fresh at each tool
call, and only fires when it can actually tell (a `git commit` on an unknown branch is
allowed through; a guard with false positives gets switched off).

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
a docker stack, a tool. Dispatch launches them per branch so you can run the app the
agent is working on, right beside the chat, without leaving the UI.

### Declaring subApps
SubApps come from one of two places:
- A committable **`.dispatch/project.yaml`** manifest at the repo root (the source of
  truth — see `packages/shared/src/project-config.ts` for the full schema), or
- The project record itself (editable in the UI; the pre-seeded Hivebreak project in
  `packages/server/src/seed.ts` is a working example).

Each subApp declares:

| Field | Meaning |
|---|---|
| `id` / `name` | stable id + display name |
| `cwd` (`path`) | dir to run in, relative to the repo root |
| `dev` | the command to spin up the dev process (e.g. `pnpm dev`); `{port}`/`{port2}`… placeholders are substituted from the **allocated** ports |
| `install` / `build` / `test` | optional lifecycle commands |
| `ports` | base port(s) the app wants (e.g. `[5173, 2567]`) |
| `env` | extra env for the dev process; same `{port}` substitution. Use when the port must reach a **nested** child the runner can't pass argv to |
| `docker` (`dockerCompose`) | a docker-compose file — declare this **instead of** `dev` for a pure docker stack (one `compose up`, no double-start) |
| `url` | open-in-browser URL, with `{port}` substituted (e.g. `http://localhost:{port}`) |

**Ports are offset per launch** so the same subApp can run on many worktrees at once without
colliding. The base is just where the allocator starts scanning; what matters is getting the
**allocated** port into the app.

The cheapest way is a `{port}` placeholder in `dev` itself — no changes in the target repo:

```yaml
dev: "npm run dev -w @app/web -- --port {port} --strictPort"
ports: [5173]
url: "http://localhost:{port}"
```

Nearly every dev server takes `--port` (Vite, Next, Astro, Nuxt, SvelteKit, Storybook,
`serve`), so this is usually the whole integration. **Always pair it with the tool's
strict-port flag.** Without it a tool that finds the allocated port busy silently binds a
different one, the recorded URL is a lie until `detectBoundPort` catches up, and repeated
launches ladder upward instead of failing. With it you get the allocated port or a loud error.

Reach for `env` when the port has to cross a process boundary the runner doesn't control —
an orchestrator or Electron shell that spawns its own children, which inherit env but not
argv. That's why Hivebreak's `game` uses `CLIENT_PORT={port}` / `SERVER_PORT={port2}`.

⚠️ The runner also sets `PORT` automatically, but **Vite ignores `PORT`** — it reads only
`server.port` or `--port`. Don't assume a bare `PORT` injection reaches a Vite-based subApp.

If a service's port is baked into client code (a hardcoded `ws://host:8787`), it can't be
offset at all without touching that code. Leave it off `ports` in the manifest and accept
one instance at a time — see `the-salesman`'s manifest for a worked example.

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

A managed repo's MCP servers live in its committable `.dispatch/project.yaml`.
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
npm i -g ./packages/cli        # from the Dispatch checkout
```

Without installing, run it from the Dispatch checkout with an explicit
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
%LOCALAPPDATA%\claude-manager\   ← still the pre-rename name; see note below
  app\            the payload — a git clone of this repo, built in place
  shell\          branded Electron runtime: dispatch.exe + resources
  data\           DISPATCH_DATA_DIR   chats, checkpoints, runners   (per-instance)
  config\         DISPATCH_CONFIG_DIR settings, projects, agents, modes (SHARED)
  current.json    published sha + timestamp (shown in the tray tooltip)
  runtime.json    present only while the app is running
```

The root is still literally `claude-manager`. Renaming it would strand every existing
chat transcript behind a one-shot migration, which is a poor trade for a directory
nobody opens — so the rebrand left it alone. Move it deliberately when you want to:
set `DISPATCH_HOME`, or run `pnpm desktop:migrate`. `DISPATCH_HOME` is read first but
`CM_HOME` still works, so a shortcut created before the rename keeps launching.

### Why there's a `shell\` with its own .exe
Windows identifies a pinned taskbar item by the **target executable**, not by the
shortcut's icon. Launch `node_modules/electron/dist/electron.exe` and Windows pins
*Electron* — so the icon "reverts" the instant you pin it, and nothing you set on the
`.lnk` can override it. `install-shell.mjs` copies Electron's `dist/` to `shell\`,
renames the binary to `dispatch.exe`, and stamps the icon and version strings in
with rcedit. It copies rather than renaming in place because `node_modules/electron`
lives in pnpm's content-addressed store, shared with every other project on the machine.

Re-run it only when Electron itself is upgraded (`pnpm desktop:install-shell`; it's a
no-op otherwise). The icon is generated — PNG for the window/tray, multi-size `.ico` for
the shortcut and the exe resource — by `pnpm --filter @dispatch/desktop icon`, which the
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
pnpm desktop:install-shell                      # branded dispatch.exe (~270 MB, once)
pnpm desktop:publish                            # build + install the payload
pnpm desktop:shortcut                           # Start-menu entry (add -- --desktop)
```
The shortcut resolves the real Start-menu / Desktop folders from Windows rather than
assuming `%USERPROFILE%\Desktop`, which OneDrive redirects.
The migration **copies** — it verifies every file by SHA-256 and never deletes or
modifies the source `.data`. Re-running it refuses a non-empty destination unless
`--force`.

### Updating
Run the **Dispatch: Publish to stable** VS Code task (or `pnpm desktop:publish`).
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
| `DISPATCH_PORT` | `4319` (desktop: `4318`) | HTTP + WebSocket port |
| `DISPATCH_DATA_DIR` | `./.data` | state dir — chats, checkpoints, runners |
| `DISPATCH_CONFIG_DIR` | = `DISPATCH_DATA_DIR` | config dir — settings, projects, agents, modes |
| `DISPATCH_MAX_ACTIVE_SESSIONS` | `6` | max concurrently-active chats |
| `DISPATCH_APP_DIR` | installed payload | run the shell against a different checkout |
| `DISPATCH_HOME` | `%LOCALAPPDATA%\claude-manager` | root for the whole installed layout |

Leaving `DISPATCH_CONFIG_DIR` unset gives the original single-root layout, byte for byte.

Projects, agents, modes, and settings are plain files under `.data/` and editable in the UI.
SubApp definitions live on the project (or its `.dispatch/project.yaml`) — adjust the run
commands and ports per repo.

## Tests
```
pnpm -C dispatch test
```
