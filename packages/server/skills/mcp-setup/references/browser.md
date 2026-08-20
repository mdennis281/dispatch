# The bundled browser MCPs

Dispatch ships two browser servers. You do **not** add them under `mcpServers`,
and you do not need `npx` — they are dependencies of Dispatch itself, spawned
with `node` off disk.

They exist because `run_subapp` returns a URL and an agent has no way to open
one. Without them, "build this component then validate it visually" ends with
the agent reading its own diff and calling it done.

| Server | Reach for it when | Tools |
| --- | --- | --- |
| `playwright` | "Is it **right**?" — is the element there, does it say the right thing, does the flow work. Its `browser_snapshot` is an accessibility tree, which answers most UI questions for a fraction of a screenshot's context. | 24 |
| `chrome-devtools` | "Then **why** is it wrong?" — console errors, the network waterfall, performance traces, a Lighthouse audit. Things an a11y tree cannot show you. | 29 |

Use the snapshot first and the screenshot when the question is genuinely visual
(spacing, colour, overlap). A screenshot's token cost scales with its
dimensions, so it is the expensive answer, not the default one.

## Turning them on

Nothing, usually. The default is `auto`: **both** servers are injected into any
project that declares a sub-app with a `url` — the signal that there is
something to point a browser at. A backend-only repo gets neither and pays no
context for them.

To override, add a `browser:` block to `.dispatch/project.yaml`:

```yaml
browser: off                  # never inject one
browser: [playwright]         # just this one, gate ignored
browser:                      # long form
  servers: [playwright, chrome-devtools]
  headless: false             # watch it work (default: headless)
  viewport: "1440x900"        # default 1280x800
  engine: chrome              # chrome | chromium | firefox | webkit | msedge
```

`browser: off` is written as YAML's `off`, which the parser resolves to boolean
`false` before any schema sees it. That spelling is handled deliberately — don't
"fix" it to a string.

## Two defaults that are not the packages' own

**Headless.** Both packages launch *headed*. On a box running several agents in
parallel that means windows stealing focus every time one looks at something,
and on a headless server it means the tool just fails.

**`engine: chrome` — the system Chrome, not Playwright's bundled Chromium.** The
bundled build is version-pinned to the `@playwright/mcp` release and is absent
until someone runs `playwright install`; the first tool call then fails with
`Browser "chrome-for-testing" is not installed`. This was verified on a machine
with five cached Chromium builds that still lacked the pinned one. Since
`chrome-devtools` requires system Chrome anyway, defaulting to it makes the whole
feature work with no download. Set `engine: chromium` (or `firefox`/`webkit`) if
you want a hermetic, version-pinned browser — then run
`pnpm exec playwright install <engine>` once.

## Why these need no port lease

[per-worktree.md](per-worktree.md) warns that a browser-fronting server which
finds a healthy instance on "its" port will **adopt** it, so a second worktree
drives the first one's browser and reports success against the wrong code.

These two escape that without a lease: each session spawns its own stdio
process, and `--isolated` gives each an ephemeral profile with a debugging port
chosen by the launcher. There is no fixed port to collide on. A browser server
you configure *yourself* still needs the lease — this exemption is theirs, not a
general rule.

## Overriding one

They are merged *underneath* a project's own `mcpServers`, so declaring a server
with the same name replaces it outright — the way to run one with flags Dispatch
doesn't expose:

```yaml
mcpServers:
  - name: chrome-devtools
    transport:
      type: stdio
      command: npx
      args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]
```

Note that `chrome-devtools` is opted **out** of Google's usage-statistics
collection by default (it is opt-out, and Dispatch installed it on the user's
behalf). Replacing the server this way opts back in unless you set
`CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS`.
