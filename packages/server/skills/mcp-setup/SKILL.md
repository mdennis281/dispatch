---
name: mcp-setup
description: Add, configure, debug, or build an MCP server for this project. Use whenever the conversation turns to installing/adding/connecting an MCP server, wiring up a tool integration (Linear, Sentry, Postgres, Figma, Playwright, a company API…), editing mcpServers config, troubleshooting a server that won't connect or whose tools aren't showing up, giving each git worktree its own MCP instance or fixing MCP port conflicts between parallel chats, returning a screenshot/video/file from a tool, or writing a new MCP server from scratch. Covers Dispatch's `.dispatch/project.yaml` config, the `cm mcp` CLI, the `mcp__manager__mcp_*` tools, and secret handling.
---

# MCP setup in Dispatch

## The one rule

**`.dispatch/project.yaml` at the repo root is the source of truth.** It is
committed, reviewed, and shared by everyone on the project. Every session in the
project loads it, and the manager watches it — an edit takes effect on the next
turn with no restart.

Do **not** configure MCP servers by writing `.mcp.json`, `~/.claude.json`,
`.claude/settings.json`, or by hand-editing `project.yaml`. Those either won't be
read, won't be shared with the team, or will skip validation. Use one of the two
supported paths below.

## Where to look

This page covers adding a server and keeping its secrets out of the repo. The
rest is split out — read the one you need, not all four.

| If you're… | Read |
|---|---|
| Running several chats/worktrees and they fight over a port | [references/per-worktree.md](references/per-worktree.md) |
| Driving a browser / looking at the UI you just built | [references/browser.md](references/browser.md) |
| Returning a screenshot, video, or file from a tool | [references/outputs.md](references/outputs.md) |
| Staring at a server that won't connect or shows no tools | [references/troubleshooting.md](references/troubleshooting.md) |
| Writing a new MCP server | [references/authoring.md](references/authoring.md) |

## Adding a server

**In-session (preferred when you're already in a chat):**

```
mcp__manager__mcp_list    → what's already configured (check first, don't duplicate)
mcp__manager__mcp_add     → add one
mcp__manager__mcp_remove  → remove one
```

**From a terminal** (identical validation, identical output — same core):

```bash
cm mcp add <name> -- <command> [args...]          # stdio (local subprocess)
cm mcp add <name> --transport http --url <url>    # remote HTTP
cm mcp add <name> --transport sse  --url <url>    # remote SSE
cm mcp add-json <name> '<json>'                   # paste a README's JSON snippet
cm mcp import [file]                              # bulk import .mcp.json / Claude Desktop
cm mcp list | get <name> | remove <name>
```

`cm` walks up from the cwd to the repo root, so it works from any subdirectory.
Add `--json` to any command for machine-readable output.

### Translating a README

Published MCP servers document themselves for `claude mcp add` or as a JSON blob.
Both map over directly:

| Their docs | Here |
|---|---|
| `claude mcp add foo -- npx -y foo-mcp` | `cm mcp add foo -- npx -y foo-mcp` |
| `{"foo":{"command":"npx","args":["-y","foo-mcp"]}}` | `cm mcp add-json foo '{"command":"npx","args":["-y","foo-mcp"]}'` |
| a whole `.mcp.json` file | `cm mcp import ./.mcp.json` |
| `"url": "https://x/mcp"` | `cm mcp add x --transport http --url https://x/mcp` |

Flag-shaped arguments (`-y`, `--port`) must come after `--`, not after
`--command` — the parser stays strict so a typo'd flag is an error, not a
silently-swallowed argument.

## Secrets — never commit a key

`project.yaml` is committed. Write a placeholder; the manager expands it from its
own environment when a session starts, so the real value never touches the repo.

```bash
cm mcp add linear --transport http --url https://mcp.linear.app/mcp \
  -H "Authorization: Bearer ${LINEAR_API_KEY}"

cm mcp add postgres -e DATABASE_URL='${DATABASE_URL}' -- npx -y @modelcontextprotocol/server-postgres
```

Supported syntax is `${VAR}` and `${VAR:-default}`. Bare `$VAR` is **not**
expanded. An unset variable expands to an empty string and surfaces as a config
warning rather than breaking the project — so if a server authenticates as
anonymous, check that its variable is actually set where the manager runs.

If the user pastes a real key at you, put the placeholder in the config and tell
them which variable to export. Don't write the literal key into `project.yaml`.

> **`${VAR}` is resolved ONCE, when config loads** — from the manager's own
> environment, shared by every chat in the project. It is the right tool for a
> secret and the wrong one for anything that must differ per chat, such as a
> port. For those, see [references/per-worktree.md](references/per-worktree.md).

## Verifying it worked

1. `mcp__manager__mcp_list` (or `cm mcp list`) — confirms it's in the config.
2. **The manager UI's MCP catalog** (top bar, or the command palette) — this is
   the real check. It probes each configured server live and shows connection
   status plus every tool it exposes, with parameters. A server that's configured
   but red there is a server that doesn't work yet.
3. The tools reach the agent as `mcp__<name>__<tool>` on the next turn.

## Choosing a transport

- **stdio** — a local subprocess. Use for anything that touches the local
  filesystem, a local database, or a CLI. Runs as a child of the manager, in the
  chat's own directory.
- **http** — a remote streamable-HTTP endpoint. The current standard for hosted
  servers.
- **sse** — the older server-sent-events remote transport. Use only when the
  server explicitly documents an SSE endpoint.

## Scope note

`cm mcp` edits **project** config — everyone who clones the repo gets it. That's
the right default for a server the team needs, and the wrong one for a personal
experiment. If the user wants a server only for themselves, say so and let them
decide before you write it.
