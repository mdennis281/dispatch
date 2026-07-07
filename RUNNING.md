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
3. **Message Claude.** Approve/deny tool permissions inline; the **Attention** badge (top bar)
   aggregates "needs input" across every chat. Run 3+ chats at once — it's a workhorse.
4. **Right panel:** worktree diff-vs-main, subApp **Runner** (start/stop, ports, live logs),
   and **PRs + GitHub Actions** (ship / merge / label / rerun / dispatch).
5. **Roll back** any message (hover it) to restore code + conversation to that point.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `CM_PORT` | `4319` | HTTP + WebSocket port |
| `CM_DATA_DIR` | `./.data` | on-disk state dir |
| `CM_MAX_ACTIVE_SESSIONS` | `6` | max concurrently-active chats |

Projects, agents, modes, and settings are plain files under `.data/` and editable in the UI
(subApp run commands live on the project — adjust them per repo).

## Tests
```
pnpm -C claude-manager test
```
