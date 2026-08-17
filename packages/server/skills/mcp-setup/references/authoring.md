# Writing an MCP server for Dispatch

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

Register it against the local entrypoint while iterating:

```bash
cm mcp add my-server -- node ./tools/my-mcp/dist/index.js
```

## What separates a good server from a bad one

- **Descriptions are the API.** The agent picks tools from the description alone.
  Say what it does, what it returns, and when to use it — not just the noun.
- **Name tools by action** (`search_orders`, not `orders`), and namespace them so
  `mcp__<server>__<tool>` reads unambiguously.
- **Constrain inputs with the schema.** Enums and `.describe()` on every field
  prevent far more bad calls than prose does.
- **Bound the output.** A tool that can return a 50k-token blob will poison the
  context. Paginate, cap, and say in the description that it's capped. For
  anything large, return a file reference — see [outputs.md](outputs.md).
- **Return errors as text with `isError: true`**, explaining what to do
  differently. Never throw raw stack traces at the agent.
- **stdout is the protocol.** For a stdio server, anything you `console.log` goes
  down the wire and corrupts the stream. Log to stderr.

## If your server binds a port

Dispatch runs one instance per chat, and chats run in parallel worktrees. Take
the port from the environment and let Dispatch lease it:

```ts
const PORT = Number(process.env.MY_PORT) || 4000;
```

```yaml
mcpServers:
  - name: my-server
    ports: 1
    transport:
      type: stdio
      command: node
      args: ["./tools/my-mcp/dist/index.js"]
      env: { MY_PORT: "{mcpPort}" }
```

Two design points that matter more than they look:

- **Never trust the port to identify your own process.** If you adopt an existing
  server on your port instead of starting a fresh one, *verify it is yours* —
  compare a checkout path, a build id, something. A port is a hint; the identity
  check is the guarantee. Without it, a mis-assigned port doesn't cost you a
  crash, it costs you a wrong answer that looks right.
- **Fail loudly on an unexpanded placeholder.** If you read a literal
  `{mcpPort}`, say so and exit. Silently falling back to a default port is how
  two checkouts end up sharing one server.

See [per-worktree.md](per-worktree.md) for the full picture, including `prewarm`
for servers whose first call is otherwise slow.

## Testing it

Run it by hand first — a stdio server is just a process; most bugs surface in its
stderr in one line. Then register it and check the manager UI's MCP catalog,
which probes it live and lists every tool with its parameters. A server that's
configured but red there is a server that doesn't work yet.

## Scope

`cm mcp` edits **project** config, so everyone who clones the repo gets it.
That's right for a server the team needs and wrong for a personal experiment —
if it's the latter, say so before writing it into the committed file.
