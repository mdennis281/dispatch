/**
 * A minimal MCP server, for the lazy shim's tests.
 *
 * TOUCHES A MARKER FILE ON START (`--marker <path>`), which is the whole point:
 * the shim's contract is "the real server is not running yet", and the only way
 * to assert that is a side effect the test can look for the ABSENCE of. Counting
 * lines or timing a response would both pass against a shim that spawned eagerly
 * and simply answered fast.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const marker = argv[argv.indexOf("--marker") + 1];
if (marker) appendFileSync(marker, "start\n");

/**
 * Records HOW this process was asked to stop (`--graceful <path>`).
 *
 * Stdin EOF is the shutdown an MCP stdio server is built around; a SIGTERM kill
 * on Windows runs no handler at all, so the file simply stays empty. That
 * asymmetry is the assertion — "it wrote stdin-eof" can only be true of the
 * graceful path.
 */
const gracefulLog = argv[argv.indexOf("--graceful") + 1];
if (gracefulLog && argv.includes("--graceful")) {
  process.stdin.on("end", () => {
    appendFileSync(gracefulLog, "stdin-eof\n");
    process.exit(0);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let workspaceRoot = process.cwd();

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
    if (msg.id === "fixture-roots" && msg.result) {
      const firstRoot = msg.result.roots?.[0]?.uri;
      if (typeof firstRoot === "string") workspaceRoot = fileURLToPath(firstRoot);
    } else if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        },
      });
    } else if (msg.method === "notifications/initialized") {
      send({ jsonrpc: "2.0", id: "fixture-roots", method: "roots/list" });
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "look", description: "look at it", inputSchema: { type: "object" } }] },
      });
    } else if (msg.method === "tools/call") {
      if (msg.params?.name === "browser_take_screenshot") {
        const filename = msg.params.arguments?.filename ?? "lazy-shim-preview-test.png";
        const outputPath = isAbsolute(filename) ? filename : resolve(workspaceRoot, filename);
        writeFileSync(outputPath, Buffer.from("89504e470d0a1a0a", "hex"));
        let printablePath = relative(workspaceRoot, outputPath);
        if (dirname(printablePath) === "." && !printablePath.startsWith(".")) printablePath = `./${printablePath}`;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              { type: "text", text: `### Result\n- [Screenshot of viewport](${printablePath})` },
            ],
          },
        });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `called ${msg.params?.name}` }] },
      });
    }
  }
});
