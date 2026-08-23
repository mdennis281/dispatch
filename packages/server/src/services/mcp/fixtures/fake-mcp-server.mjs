/**
 * A minimal MCP server, for the lazy shim's tests.
 *
 * TOUCHES A MARKER FILE ON START (`--marker <path>`), which is the whole point:
 * the shim's contract is "the real server is not running yet", and the only way
 * to assert that is a side effect the test can look for the ABSENCE of. Counting
 * lines or timing a response would both pass against a shim that spawned eagerly
 * and simply answered fast.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const marker = argv[argv.indexOf("--marker") + 1];
if (marker) appendFileSync(marker, "start\n");

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "look", description: "look at it", inputSchema: { type: "object" } }] },
      });
    } else if (msg.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `called ${msg.params?.name}` }] },
      });
    }
  }
});
