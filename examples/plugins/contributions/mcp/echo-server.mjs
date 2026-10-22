// The smallest stdio MCP server that a session can call: newline-delimited
// JSON-RPC over stdin/stdout, no dependencies, no build. One tool, `echo`,
// which returns its argument — enough to prove a plugin-contributed server's
// tools reach a session and the catalog lists it as kind `plugin`.
//
// `cwd` is the plugin directory (the host's default for a plugin server), so
// `process.cwd()` below names the plugin, not the chat's repo — that is what
// `tools/call echo` reports back, as a check anyone can read in the transcript.
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
// Stdin EOF is how an MCP stdio server is asked to stop. Exit on it rather than
// linger as an orphan the session's teardown can no longer reach.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "contrib-echo", version: "0.1.0" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo `text` back, prefixed with the server's working directory.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "What to echo." } },
                required: ["text"],
              },
            },
          ],
        },
      });
    } else if (msg.method === "tools/call") {
      const text = String(msg.params?.arguments?.text ?? "");
      const token = process.env.ECHO_TOKEN ? " (token set)" : "";
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `[${process.cwd()}]${token} ${text}` }] },
      });
    } else if (msg.id !== undefined && msg.method) {
      // Anything else that expects an answer gets the standard "no such method".
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  }
});
