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
1. **Project** — pick one from the selector, or start a new one (⌘K → *New project*, or
   *New project…* in the selector). *Hivebreak is pre-seeded.* See
   [New project](#new-project) below.
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

## New project

**⌘K → New project** (or *New project…* in the project selector) opens a full-page setup
screen: the form on the left, the `.dispatch/project.yaml` it's about to write on the
right, re-rendered as you type. Both halves come from the same function the server writes
the file with, so the preview is the file rather than an impression of it.

- **Name → directory.** Typing a name fills the project directory, under wherever your
  existing projects live. Edit the path and it stops following; every derived field works
  the same way.
- **The line under the path is the disk talking.** An existing checkout, an empty folder
  and a path that doesn't exist yet are three different setups, and it says which one you
  have *before* you press anything. A directory that isn't a repo yet (or isn't there yet)
  gets `git init`-ed on create — `git init` only ever adds `.git/`, never runs against a
  repo that already exists, and never runs against a path *inside* one (a monorepo
  subdirectory is already tracked; a nested repo there would describe an empty tree). The
  path has to be absolute: a relative one would resolve against the server.
- **A repo that already has a `.dispatch/` keeps it.** The committed manifest is the source
  of truth and overrides the stored record on every config load, so when you point at a
  repo that carries one, the fields it owns (name, worktree root, workflow, apps) go
  read-only, the right pane shows *that file* rather than a preview, and the setup agent is
  told to extend it — not to re-derive it and drop your `instructions:` along the way.
- **Worktree root** defaults to `.worktrees` inside the repo — one directory per repo
  holding a subdirectory per branch, which keeps a project one folder you can move or
  delete as a unit. Add it to `.gitignore`. A relative root is resolved against the repo,
  so it stays portable across machines.
- **Finish with AI** saves exactly what the form has — nothing invented — and opens a chat
  briefed to do the rest: read the repo, register the sub-apps with their real dev/build/
  test commands and ports, and write instructions or skills where the repo earns them. An
  empty directory flips that brief from an audit into a build: it scaffolds the project to
  your description first, then records what it built. **Create without AI** skips the
  hand-off and just saves.

Screenshot it any time with `node tools/verify/shot.mjs --flow newproject` — the flow
never presses either button, so it's safe against a live install.

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

## Installed app (stable) vs `pnpm dev` (unstable)

Two instances, on purpose: an **installed PWA** you can trust with long-running agents,
and the **hot-reload dev server** you break things in. They run side by side.

| | Stable | Dev |
|---|---|---|
| Launch | Start-menu shortcut / `pnpm app` | `pnpm dev` |
| Port | **4318** (scans up if taken) | **4319** |
| Code | published payload in `%LOCALAPPDATA%` | this checkout, hot-reloaded |
| Updated by | the *Ship: publish HEAD* VS Code task | saving a file |

### Install
```
pnpm app:migrate -- --dry-run   # preview the data move; then drop --dry-run
pnpm app:publish                # build + install the payload
pnpm app:shortcut               # Start-menu entry (add -- --desktop for a Desktop one)
```
Then click the shortcut once. Dispatch notices it's running in a browser tab and offers
**Install Dispatch** in the bottom-right corner — click the card and the browser's real
install flow runs. (Chrome's own **Install** icon in the address bar does the same thing;
the card exists because nobody finds that icon.) Installing is what gives the app its own
window, taskbar identity and icon — pin *that*, not the shortcut.

The card appears only when the browser is actually offering an install, so it goes away
for good once you're installed. **Not now** hides it for a week.

The shortcut resolves the real Start-menu / Desktop folders from Windows rather than
assuming `%USERPROFILE%\Desktop`, which OneDrive redirects. The migration **copies** —
it verifies every file by SHA-256 and never deletes or modifies the source `.data`.
Re-running it refuses a non-empty destination unless `--force`.

**Requirements:** Python 3.10+ with `pip install pwa-launcher`, and any Chromium-based
browser (Chrome, Edge, Brave, Vivaldi…).

### Layout
```
%LOCALAPPDATA%\claude-manager\    ← still the pre-rename name; see note below
  app\               the payload — a git clone of this repo, built in place
  data\              DISPATCH_DATA_DIR   chats, checkpoints, runners   (per-instance)
  config\            DISPATCH_CONFIG_DIR settings, projects, agents, modes (SHARED)
  browser-profile\   the PWA's own Chromium profile (window state, mic permission)
  current.json       published sha + timestamp
  runtime.json       present only while the app is running
```

The root is still literally `claude-manager`. Renaming it would strand every existing
chat transcript behind a one-shot migration, which is a poor trade for a directory
nobody opens — so the rebrand left it alone. Move it deliberately when you want to:
set `DISPATCH_HOME`, or run `pnpm app:migrate`. `DISPATCH_HOME` is read first but
`CM_HOME` still works, so a shortcut created before the rename keeps launching.

**`config/` is shared, `data/` is not** — and that split is deliberate. Projects, agents
and modes are written rarely and are miserable to maintain twice, so both instances read
one copy. Chats are the opposite: `checkpoints.json` and `runners.json` are whole-file
read-modify-write maps guarded by an *in-process* mutex, so two processes sharing them
would silently drop each other's entries. Losing rollback points on the instance you
trust with long work isn't a tradeoff worth making, so each instance keeps its own chats.
Want to see stable's chats while working in dev? Open both tabs.

### Why a PWA and not an Electron shell
The old shell did two unrelated jobs, and only one of them needed 270 MB.

As a **window**, Chromium does it better: an installed PWA gets its own taskbar identity
and icon for free. Electron needed a renamed, rcedit-stamped `dispatch.exe` copied per
version just to stop Windows pinning "Electron" — because a pinned taskbar item resolves
to its target executable, not to the shortcut's icon.

It also cost a feature. Electron ships without Chrome's speech service key, so Web Speech
died the moment the mic opened, and dictation needed 114 MB of vendored Whisper weights
to work around it. In a real browser the API is just there.

The one thing lost is drag-and-drop of exact paths: Electron's preload could resolve
*any* dropped file via `webUtils.getPathForFile`. A browser can't. Drags from VS Code,
JetBrains and terminals still carry their path as text and work as before; an Explorer
drag now falls back to matching the basename against the project index.

### Process ownership
`tools/app/launch.py` supervises the server. It spawns it, holds its **stdin**, and
advertises it in `runtime.json`. The server owns every SDK session and subApp below that.

Stopping asks over stdin, because Windows can't deliver `SIGTERM` — `os.kill(pid,
SIGTERM)` maps to `TerminateProcess`, which runs no handler and would orphan every subApp
holding a port. The stdin request runs `services.dispose()` → `runner.stopAll()` first,
then the supervisor waits out the grace window before killing anything.

Closing the PWA window does **not** stop the server, deliberately: a reflex Alt-F4 must
not kill a three-hour run. Agents keep working. Stop it when you mean it — three doors
onto the same teardown:

| | |
|---|---|
| **In the app** | Settings (⚙) → **Stop** → confirm. Also `⌘K` → "Stop Dispatch". |
| **From a terminal** | `pnpm app:stop` (and `pnpm app:status` for what's running) |
| **In a `pnpm dev` window** | Ctrl-C |

All three run `services.dispose()` → `runner.stopAll()`, so subApps die with the server
instead of orphaning themselves onto the ports they hold. A `taskkill` on the pid does
**not**: on Windows that's `TerminateProcess`, no handler runs, and every dev server it
spawned survives as an orphan for the Ports & processes panel to clean up.

The in-app button names what it's about to kill ("3 agents are working and 2 sub-apps are
running") rather than asking a question nobody can answer. And because a deliberate stop
is otherwise indistinguishable from a crash, the server announces it on the WS first:
every connected client — including the tabs on other devices in [host mode](#host-mode) —
stops reconnecting and shows a **Dispatch has stopped** screen with a Reconnect button,
instead of spinning forever at a port nobody is listening on.

### Updating
Run the **Ship: publish HEAD** VS Code task (or `pnpm app:publish`). It publishes the
**committed** `HEAD` — a dirty working tree is reported loudly and *not* included,
because a "stable" build you can't reproduce from git isn't stable.

It **refuses to run while the app is up**; `pnpm app:stop` first. If the build fails it
rolls the payload back to the previous sha, rebuilds, and re-prints the original error
last, after the rollback's output. It also verifies the built payload (server entry, SPA
shell, manifest, service worker, icon, launcher) before stamping it — a build that exits
0 without emitting `dist` is not a successful publish.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `DISPATCH_PORT` | `4319` (installed app: `4318`) | HTTP + WebSocket port |
| `DISPATCH_HOST` | `0.0.0.0` | bind address — see [Host mode](#host-mode) |
| `DISPATCH_DATA_DIR` | `./.data` | state dir — chats, checkpoints, runners |
| `DISPATCH_CONFIG_DIR` | = `DISPATCH_DATA_DIR` | config dir — settings, projects, agents, modes |
| `DISPATCH_MAX_ACTIVE_SESSIONS` | `6` | max concurrently-active chats |
| `DISPATCH_IPC` | unset | `1` makes the server accept `shutdown` on stdin (the launcher sets it) |
| `DISPATCH_HOME` | `%LOCALAPPDATA%\claude-manager` | root for the whole installed layout |

To run the launcher against a checkout instead of the installed payload, pass
`--app-dir` rather than an env var: `python tools/app/launch.py --app-dir .`

Leaving `DISPATCH_CONFIG_DIR` unset gives the original single-root layout, byte for byte.

## Host mode

Dispatch binds **every interface** by default, so the same control plane is reachable from
a phone or another laptop while the agents keep running on the box that owns the repos.
Boot prints both addresses:

```
[dispatch] listening on http://127.0.0.1:4318  (data: …)
[dispatch] host mode — also reachable at http://192.168.1.20:4318  (no auth: …)
```

Two things to know:

- **There is no authentication.** Anything that can reach the port can start a chat and
  approve a tool call, which means running commands as you. That's fine behind your own
  NAT and wrong on a network you don't control — set `DISPATCH_HOST=127.0.0.1` there and
  you're back to loopback-only.
- **Only `localhost` gets the browser features.** Chromium treats `http://localhost` as a
  secure context and a LAN IP as insecure, so over `http://192.168.x.x` there is no
  service worker, no install prompt and no notifications — the API is withheld entirely.
  The app says so rather than showing dead buttons (Settings → Notifications). If you want
  those on another device, put the LAN origin behind HTTPS.

## Notifications

Three independent channels, in order of how far they reach:

| | Where it shows | Needs |
|---|---|---|
| **Attention badge** | top bar, in-app | nothing |
| **Desktop notifications** | your OS notification centre | one click to grant the browser permission |
| **Webhook** (ntfy / Pushover) | your phone, anywhere | a URL in Settings |

**Desktop notifications** fire on the same four Attention events as the webhook —
permission needed, question, waiting for input, task done — and only while the app *isn't*
focused, because with the window in front of you the badge already said it. Clicking one
focuses the app and jumps to the chat, scrolling the pending card into view; answering a
prompt in the app withdraws its toast so the notification centre never fills with
decisions you already made.

Dispatch asks once, from a card in the bottom-right corner — the permission prompt needs a
click, and an origin that asks on page load gets auto-blocked by Firefox. Dismissed it?
Settings (⚙) → Notifications → **Enable**. The same panel has the mute switch, which is
stored per browser rather than server-side, because the underlying permission is granted
per browser and "on" can't honestly mean anything else.

Projects, agents, modes, and settings are plain files under `.data/` and editable in the UI.
SubApp definitions live on the project (or its `.dispatch/project.yaml`) — adjust the run
commands and ports per repo.

## Tests
```
pnpm -C dispatch test
```
