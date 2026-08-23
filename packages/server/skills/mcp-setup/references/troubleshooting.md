# When an MCP server misbehaves

Start at the **manager UI's MCP catalog** (top bar, or the command palette). It
probes every configured server live and shows its status and tool list. Its error
message tells you which rung of this ladder you're on.

## Won't connect

- **stdio, "command not found"** — the command must be on the manager's PATH.
  `npx`/`uvx` need node/python available to the *manager process*, not just your
  shell. Test it directly: `npx -y the-package --help`.
- **stdio, exits immediately** — usually a missing required env var. Run the
  command by hand, from the chat's directory, with the same env, and read stderr.
- **stdio, "cannot find module ./tools/…"** — the path is resolved from the
  chat's own directory. In a fresh worktree, a build output or `node_modules`
  that exists in the primary checkout may simply not be there yet. That is
  usually a missing install/build step, not a config error.
- **http/sse, 401/403** — the `${VAR}` didn't expand (unset where the manager
  runs) or the header name is wrong. `cm mcp get <name>` shows exactly what's
  stored.
- **http/sse, connection refused / 404** — wrong transport. Some servers publish
  an `/sse` endpoint and some a streamable `/mcp` one; they are not
  interchangeable. Try the other with `--transport`.

## Connects, but wrong

- **No tools at all** — the server started but registered nothing. Check its own
  logs/version; this is a bug in that server, not in the config.
- **Nothing changed after an edit** — config changes apply to the NEXT turn.
  Finish the turn, or start a new one.
- **Garbled protocol / random disconnects on stdio** — something is writing to
  **stdout**. For a stdio server stdout *is* the wire; a stray `console.log`
  corrupts it. All logging must go to stderr.
- **A `{mcpPort}` shows up literally in an error** — the port lease failed, so
  substitution was skipped. Usually the band is full of stale leases; see
  [per-worktree.md](per-worktree.md).

## Two chats interfering with each other

Symptoms: "address in use"; one chat's changes showing up in another's results; a
tool reporting success against code you didn't write.

This is the port-sharing failure, and the quiet version (adopting another
checkout's server) is much more common than the loud one. Read
[per-worktree.md](per-worktree.md) — the fix is `ports:` plus a `{mcpPort}`
placeholder, and *not* `${VAR}`, which is identical for every chat in the
project.

## Reading the actual config

```bash
cm mcp list          # names + transports
cm mcp get <name>    # exactly what is stored, post-expansion
```

`mcp__dispatch-mcp__mcp_list` is the in-session equivalent. Note both show the
*configured* set; the catalog shows live status.

## When you're stuck

Reproduce outside Dispatch. Run the server's command by hand from the chat's
directory with the same environment; almost every stdio failure reproduces there
in one line of stderr, which is faster than reading it through two layers of
protocol.
