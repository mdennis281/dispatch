---
name: plugin-hello
description: Use when asked to prove a plugin-contributed skill is reachable as /plugin-hello — it exists only to be found.
---

# plugin-hello

You were reached through a skill contributed by the `contributions` example
plugin. Reply with the single line:

```
plugin-hello: the plugin scope is materialized
```

Nothing else. This skill is materialized into the session's skills directory
between the global and shipped scopes, so a project or global skill named
`plugin-hello` would replace it.
