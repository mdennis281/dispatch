# One MCP per worktree

The problem this solves: several chats work in parallel, each in its own git
worktree, and they all start the same MCP server. If that server binds a port —
most do, because they front a dev server, a browser, or an inspector — they
collide.

A port clash is the *visible* failure. The dangerous one is quieter: a server
that finds a healthy instance already on "its" port will often **adopt** it
rather than start a second. The second worktree then drives the first
worktree's process, and reports success while testing the wrong code.

## Two things make a server per-worktree

### 1. It already runs in the right directory

A stdio server's working directory defaults to **the chat's own directory** — its
worktree when it has one, otherwise the repo root. So a relative command resolves
inside that worktree:

```yaml
mcpServers:
  - name: sim
    transport:
      type: stdio
      command: node
      args: ["./tools/sim-mcp/index.mjs"]   # resolves inside THIS chat's worktree
```

A server that derives identity from its own location (`__dirname`, or walking up
to a repo root) therefore gets the right answer for free.

Setting `cwd:` explicitly **opts out** and pins every chat to one directory. Only
do that when you actually want one shared instance.

### 2. It gets its own port, leased

Declare how many ports the server needs and write the placeholder instead of a
number:

```yaml
mcpServers:
  - name: sim
    ports: 1                     # lease 1 port per checkout
    portRange: [5400, 5499]      # optional; this is the default band
    transport:
      type: stdio
      command: node
      args: ["./tools/sim-mcp/index.mjs"]
      env:
        SIM_PORT: "{mcpPort}"    # ← NOT ${SIM_PORT:-5273}
```

Ports are leased per **(project, server, checkout)** and persisted, so a checkout
keeps the same port across restarts. That stability matters: a server that adopts
an already-healthy instance on its port needs the port to still be the one it
booted on, and a port that moved every restart would strand the old process.

Leases are released when the worktree is removed, and any lease whose directory
has vanished is reclaimed the next time a port is allocated — so a crash or a
manual `git worktree remove` self-heals.

## Placeholders

Substituted per session into `env`, `args`, and `url`:

| Token | Value |
|---|---|
| `{mcpPort}`, `{mcpPort2}`, … | leased ports, 1-indexed (`{mcpPort}` == `{mcpPort1}`) |
| `{worktree}` | absolute path of the chat's directory |
| `{worktreeName}` | that directory's name (the branch slug) |
| `{repoRoot}` | the project's primary checkout |
| `{chatId}` | the calling chat's id |

An unknown or out-of-range placeholder is left **literal** rather than blanked.
That is deliberate: an empty string reads to most servers as "unset", and they
quietly fall back to their shared default port — which is the collision you were
trying to prevent. Seeing `{mcpPort3}` in a server's error message tells you
exactly what's wrong.

## `${VAR}` vs `{token}` — the trap

They look similar and are resolved at different times by different things.

| | `${VAR}` | `{token}` |
|---|---|---|
| Resolved | once, at config load | per session |
| Source | the manager's environment | the chat's checkout + its leases |
| Same for every chat? | **yes** | no |
| Use for | secrets, machine paths | ports, worktree paths |

Writing `SIM_PORT: "${SIM_PORT:-5273}"` and expecting each worktree to get its
own does not work: it bakes one literal into every chat in the project. This is
not hypothetical — it is the bug this feature exists to fix.

## Warming a worktree up

A stdio MCP is spawned lazily, on the first tool call, so a server that boots a
dev server pays that boot cost right there — on the call you are waiting for. Add
a `prewarm` command and it happens at worktree-creation time instead:

```yaml
mcpServers:
  - name: sim
    ports: 1
    prewarm: "npm run dev:sim"
    transport: { type: stdio, command: node, args: ["./tools/sim-mcp/index.mjs"] }
```

It runs in the new worktree with the **same** resolved environment the session
will get, leased port included — so what it boots is what the session then
adopts, not a second server somewhere else.

It is best-effort by design: worktree creation does not wait for it and a failure
never fails the worktree. You get a notice either way.

To re-warm a checkout whose server has since died, call
`mcp__manager__prewarm_mcp` — no arguments; it acts on the calling chat's own
checkout.

Note the child environment is scrubbed of the manager's own `DISPATCH_*`/`CM_*`
state vars, so a prewarm can't come up pointed at Dispatch's own data directory.

## Checklist for a server that binds a port

- [ ] `ports:` declared, and the port written as `{mcpPort}` — not a literal, and
      not `${VAR}`
- [ ] no explicit `cwd:` (unless one shared instance is genuinely wanted)
- [ ] the server tolerates its port being anything, not just its historical default
- [ ] it verifies the *identity* of a server it adopts, rather than trusting that
      whatever answers on the port is its own — the port is a hint, the identity
      check is the guarantee
- [ ] `prewarm:` set if its first call is otherwise slow
