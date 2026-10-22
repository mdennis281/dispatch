# contributions

A plugin with no server module that still changes what every session gets —
one of each contribution kind. Install it to see the `plugin` scope working:

```
dispatch plugin link examples/plugins/contributions     # or: dispatch plugin add …
# restart Dispatch
```

Then:

| contribution | where it shows up |
|---|---|
| `modes/careful.yaml` | the composer's mode picker and `mode_list`, scope `plugin` |
| `skills/plugin-hello/` | the `/` menu as `/plugin-hello`, labelled `plugin` |
| `instructions/contributions-plugin.md` | every session's "Global instructions" block, between shipped and global |
| `personas/plugin-reviewer.md` | `config_list kind:persona`; pick it with `chat_set_persona` |
| `mcp.yaml` → `contrib-echo` | the MCP catalog under **Plugins** (kind `plugin`); its `echo` tool reaches the session |
| `processes.yaml` → `hello-http` | Ports & processes, grouped under the plugin; `http://localhost:47311` |

Precedence is `project > global > plugin > shipped` for every kind: a project
or global item of the same name replaces the plugin's, and the plugin's
replaces Dispatch's own. `config_write` / `mode_write` refuse the `plugin`
scope — these files belong to the plugin and would be lost on reinstall.

Switching the plugin off in Settings → Plugins removes every contribution
except the MCP server's catalog row, which stays listed as switched off (its
default is the plugin's toggle) so an `mcpEnabled` pin still has something to
point at.

`packages/server/src/plugins/contributions.test.ts` loads this directory as
its fixture, so changing what it declares changes what the host's tests assert.
