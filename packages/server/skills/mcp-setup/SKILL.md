---
name: mcp-setup
description: Add, configure, debug, or build an MCP server for this project. Use whenever the conversation turns to installing/adding/connecting an MCP server, wiring up a tool integration (Linear, Sentry, Postgres, Figma, Playwright, a company API…), editing mcpServers config, troubleshooting a server that won't connect or whose tools aren't showing up, or writing a new MCP server from scratch. Covers claude-manager's `.claude-manager/project.yaml` config, the `cm mcp` CLI, the `mcp__manager__mcp_*` tools, and secret handling.
---

# MCP setup in claude-manager

## The one rule

**`.claude-manager/project.yaml` at the repo root is the source of truth.** It is
committed, reviewed, and shared by everyone on the project. Every session in the
project loads it, and the manager watches it — an edit takes effect on the next
turn with no restart.

Do **not** configure MCP servers by writing `.mcp.json`, `~/.claude.json`,
`.claude/settings.json`, or by hand-editing `project.yaml`. Those either won't be
read, won't be shared with the team, or will skip validation. Use one of the two
supported paths below.

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

## Verifying it worked

1. `mcp__manager__mcp_list` (or `cm mcp list`) — confirms it's in the config.
2. **The manager UI's MCP catalog** (top bar, or the command palette) — this is
   the real check. It probes each configured server live and shows connection
   status plus every tool it exposes, with parameters. A server that's configured
   but red there is a server that doesn't work yet.
3. The tools reach the agent as `mcp__<name>__<tool>` on the next turn.

## When a server won't connect

Work down this list — the catalog's error message tells you which rung you're on.

- **stdio, "command not found"** — the command must be on the manager's PATH.
  `npx`/`uvx` need node/python available to the manager process, not just your
  shell. Test it directly: `npx -y the-package --help`.
- **stdio, exits immediately** — usually a missing required env var. Run the
  command by hand with the same env and read its stderr.
- **http/sse, 401/403** — the `${VAR}` didn't expand (unset where the manager
  runs) or the header name is wrong. `cm mcp get <name>` shows exactly what's
  stored.
- **http/sse, connection refused / 404** — wrong transport. Some servers publish
  an `/sse` endpoint and some a streamable `/mcp` one; they are not
  interchangeable. Try the other with `--transport`.
- **Connects, but no tools** — the server started but registered nothing; check
  its own logs/version. This is a bug in that server, not in the config.
- **Nothing changed after an edit** — config changes apply to the NEXT turn.
  Finish the turn, or start a new one.

## Choosing a transport

- **stdio** — a local subprocess. Use for anything that touches the local
  filesystem, a local database, or a CLI. Runs as a child of the manager.
- **http** — a remote streamable-HTTP endpoint. The current standard for hosted
  servers.
- **sse** — the older server-sent-events remote transport. Use only when the
  server explicitly documents an SSE endpoint.

## Building a new MCP server

When nothing off-the-shelf fits, write one. Use the official SDK
(`@modelcontextprotocol/sdk` for TypeScript, `mcp` for Python) rather than
implementing the protocol by hand.

Sketch (TypeScript, stdio):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool(
  "search_orders",
  "Search orders by customer email. Returns at most 20, newest first.",
  { email: z.string().describe("Customer email address") },
  async ({ email }) => ({ content: [{ type: "text", text: await search(email) }] }),
);

await server.connect(new StdioServerTransport());
```

Then register it against the local entrypoint while iterating:

```bash
cm mcp add my-server -- node ./tools/my-mcp/dist/index.js
```

What separates a good server from a bad one:

- **Descriptions are the API.** The agent picks tools from the description alone.
  Say what it does, what it returns, and when to use it — not just the noun.
- **Name tools by action** (`search_orders`, not `orders`), and namespace them so
  `mcp__<server>__<tool>` reads unambiguously.
- **Constrain inputs with the schema.** Enums and `.describe()` on every field
  prevent far more bad calls than prose does.
- **Bound the output.** A tool that can return a 50k-token blob will poison the
  context. Paginate, cap, and say in the description that it's capped.
- **Return errors as text with `isError: true`**, explaining what to do
  differently. Never throw raw stack traces at the agent.
- **stdout is the protocol.** For a stdio server, anything you `console.log` goes
  down the wire and corrupts the stream. Log to stderr.

## Scope note

`cm mcp` edits **project** config — everyone who clones the repo gets it. That's
the right default for a server the team needs, and the wrong one for a personal
experiment. If the user wants a server only for themselves, say so and let them
decide before you write it.
