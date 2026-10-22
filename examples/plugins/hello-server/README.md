# hello-server

The canonical minimal server plugin. Install it to see the host working:

```
dispatch plugin link examples/plugins/hello-server     # or: dispatch plugin add examples/plugins/hello-server
# restart Dispatch
curl http://127.0.0.1:4319/api/plugins/hello-server/hello
```

It declares three capabilities (`events`, `routes`, `kv`), a settings schema
the Settings → Plugins pane renders as a form, and nothing else. The server
module is dependency-free JavaScript so there is no build step between
editing it and restarting.

`packages/server/src/plugins/service.test.ts` loads this directory as its
fixture, so changing what it does changes what the host's tests assert.
