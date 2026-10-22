// The managed process: a one-route HTTP server on the port the runner leased.
// `PORT` is injected by the runner exactly as for a sub-app; the manager's own
// DISPATCH_* identity vars are scrubbed before this starts (see
// `scrubManagerEnv`), which is why reading `process.env.DISPATCH_DATA_DIR`
// here would come back empty even though the server that spawned us has one.
import { createServer } from "node:http";

const port = Number(process.env.PORT) || 47311;
createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ plugin: "contributions", process: "hello-http", pid: process.pid, port }));
}).listen(port, "127.0.0.1", () => {
  // The runner reads this line to reconcile the port it recorded with the one
  // actually bound (`detectBoundPort`), so print it in the shape it parses.
  console.log(`hello-http listening on http://127.0.0.1:${port}/`);
});
