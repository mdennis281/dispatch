# Contributions — modes, skills, instructions, personas, MCP servers, processes

A plugin can change what every session gets **with no code at all**, by pointing
`contributes:` at directories and files Dispatch already understands. Reference:
`examples/plugins/contributions` (one of each). Contributions are read once, at load;
changing them needs a restart like everything else.

```yaml
capabilities: [mcp, process]     # mcpServers needs `mcp`, processes needs `process`; otherwise a row warning and nothing runs
secrets: [CONTRIB_ECHO_TOKEN]    # the only names ${secret:…} may reference in mcp.yaml
contributes:
  modes: ./modes                 # <id>.yaml files, the project-mode shape
  skills: ./skills               # <name>/SKILL.md directories
  instructions: ./instructions   # .md files, injected into every session
  personas: ./personas           # <name>.md
  mcpServers: ./mcp.yaml
  processes: ./processes.yaml
```

Non-fatal problems — a malformed file, a `dispatch-*` server name, a process declared
without the `process` capability — are dropped and reported in `PluginInfo.warnings`
on the Settings row. The plugin still activates.

## The `plugin` scope

Authored guidance has four scopes: `shipped → plugin → global → project`.

- **Skills** materialize into the session's `.claude/skills/` in that order with
  never-clobber, so a project or global skill of the same name wins over yours, and
  yours wins over Dispatch's shipped one. The `/` menu labels yours `plugin`.
- **Instructions** are injected broadest-first (shipped, then plugin, then global, then
  project), so yours are read before the operator's own.
- **Personas** resolve through the same list; **modes** are a fourth mode home, listed
  by `GET /api/modes` and `mode_list` with scope `plugin`, resolvable by the broker,
  shadowed by a project or store mode of the same id.
- The scope is **read-only**: `config_write` / `config_delete` / `mode_write` refuse it
  (the files belong to the plugin and would be lost on reinstall). `config_list`
  reports each item with the plugin id.

Switching the plugin off removes every contribution except an MCP server's catalog row
(below).

## MCP servers — `mcp.yaml`

The same per-server shape a project's `mcpServers:` list uses (a bare list or
`{ mcpServers: [...] }`), so a definition moves between a project manifest and a plugin
unchanged:

```yaml
mcpServers:
  - name: contrib-echo                 # NOT dispatch-*; that prefix is refused with the same sentence `mcp_add` uses
    transport:
      type: stdio
      command: node
      args: ["./mcp/echo-server.mjs"]
      env:
        ECHO_TOKEN: "${secret:CONTRIB_ECHO_TOKEN}"
```

Two things differ from a project server, both the loader's doing:

- **`cwd` defaults to the plugin directory** (a project server's default is the chat's
  tree, which is wrong for code that ships with the plugin). A relative `cwd` resolves
  against the plugin dir.
- **`${secret:NAME}` expands from the GLOBAL secret store only for names the manifest
  lists under `secrets:`**; an unlisted name is blanked and reported as a warning.

They appear in the MCP catalog under **Plugins** with kind `plugin`, are probed in the
plugin dir, and merge **under** project servers and Dispatch's own `dispatch-*`
category servers (`bundled < plugin < project .data < project config < dispatch-*`), so
a project can shadow yours by name. Enablement runs through the normal layered
`mcpEnabled` resolver with the plugin's toggle as the default layer — which is why a
**disabled plugin's server stays listed, switched off, with the reason**: a per-project
pin still has something to point at. Tools reach the session as `mcp__<name>__<tool>`
on the next turn.

## Managed processes — `processes.yaml`

```yaml
processes:
  - id: whisper                        # [a-z0-9][a-z0-9-]{0,39}; the runner's subAppId
    name: Whisper server
    command: python
    args: ["-m", "whisper_server", "--port", "{port}"]   # command + args are joined into ONE shell line
    env: { MODEL: small }
    cwd: ./server-side                 # relative to the plugin dir; default the plugin dir
    ports: [9100]                      # base ports to lease; the first is injected as PORT and fills {port}
    url: "http://localhost:{port}"     # the one-click URL in Ports & processes
    autostart: true                    # start on activation (BEFORE the module's activate runs)
    singleton: true                    # one per machine — requires ports
```

Processes run through the same `RunnerService` as a project's sub-apps, with owner
`plugin:<id>`: leased ports, persisted logs, a row in **Ports & processes** (grouped
"Plugin · <id>"), the manager-env quarantine (Dispatch's own `DISPATCH_*` identity
variables are scrubbed before the child starts), and the orphan reaper. They stop on
deactivate, toggle-off and shutdown. `ctx.processes.start/stop/list` drives them on
demand.

**Singleton is by declared PORT.** Both instances (stable and dev) load the same
plugin; with `singleton: true` the second to activate probes the first declared port
and **adopts** a listener it finds (a `running` record with no pid; its `stop()` kills
nothing) instead of spawning a second copy one port up. Port leases and runner rows are
per instance, so the port is the only identity the two can both see — which is why the
schema requires `ports` on a singleton.

Print the bound port on one line when you start (`listening on http://127.0.0.1:<port>/`)
— the runner reads it to reconcile the port it recorded with the one actually bound.
