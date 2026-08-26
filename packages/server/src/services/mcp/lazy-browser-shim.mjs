/**
 * LAZY STDIO SHIM — an MCP server that isn't running yet.
 *
 * WHY. The two bundled browser servers are attached to every session whose
 * project has something to point a browser at, which for a web repo is every
 * session. They then sit there: measured on a real install, fifteen resident
 * chats were holding fifteen `@playwright/mcp` processes and fifteen
 * `chrome-devtools-mcp` processes, ~100 MB each, and almost none of them had
 * been asked to do anything. The alternative — gating them behind a config flag
 * an agent has to notice and a human has to flip — is the "hard barrier" that
 * made agents ship UI they had never looked at in the first place.
 *
 * So neither is gated and neither is preferred: BOTH are advertised, the agent
 * picks whichever answers its question, and the process behind the one it picks
 * starts at that moment. The cost moves from "always, per session" to "once, on
 * first use" — a spin-up the first call waits through instead of a resident
 * process every session pays for.
 *
 * HOW. This process speaks MCP on stdio in place of the real server:
 *
 *   • `initialize` and `tools/list` are answered from a MANIFEST cached on disk,
 *     so the tools are listed and callable without anything being spawned.
 *   • The first request that needs the real server (a `tools/call`, or anything
 *     not in the manifest) spawns it, replays the handshake with the client's
 *     OWN initialize params, and forwards. From then on this is a pipe.
 *   • With no manifest — first ever run, or the command changed — it spawns
 *     immediately and proxies transparently, capturing the handshake on the way
 *     through so the NEXT session is lazy. Being wrong here costs a process,
 *     never a broken tool.
 *
 * Plain `.mjs`, not TypeScript, because it is spawned by path: `tsc` would emit
 * it to `dist` in a build and leave `tsx` looking for it in `src` during dev, so
 * the one file that has to exist at the same relative path in both modes is the
 * one file that must not be compiled. `scripts/copy-mjs-assets.mjs` copies it
 * into `dist` verbatim.
 *
 * NO DEPENDENCIES, deliberately: this runs as its own process before anything
 * else is loaded, and a require of the server's own tree would drag a container
 * into a shim whose whole point is to be cheaper than the thing it stands in for.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ argv */

// `--owner-dir <per-chat path> --manifest <path> -- <command> <args...>`. The
// The owner dir is both the process cwd and the root used to turn Playwright's
// Markdown-only screenshot answer into a standard MCP resource_link. Keeping
// it in THIS process's argv also makes ownership recoverable for a real server
// with no output flag. The `--` matters: the real
// server's own args routinely include flags of ours' shape (`--isolated`), and
// splitting on the first bare `--` is the one rule that can't confuse them.
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const flags = sep === -1 ? argv : argv.slice(0, sep);
const real = sep === -1 ? [] : argv.slice(sep + 1);
const flagValue = (name) => {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
};
const manifestPath = flagValue("--manifest");
const ownerDir = flagValue("--owner-dir");
const realCommand = real[0];
const realArgs = real.slice(1);

if (!realCommand) {
  process.stderr.write("lazy-browser-shim: no command after `--`\n");
  process.exit(2);
}

/* -------------------------------------------------------------- manifest */

/**
 * `{ initialize: <result>, tools: <result> }` — the two answers that let a
 * client believe it is talking to a live server.
 *
 * A read failure is indistinguishable from "no manifest yet" ON PURPOSE: both
 * mean "spawn and find out", which is correct and self-healing for a corrupt or
 * half-written file as much as for a missing one.
 */
function readManifest() {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    return raw && raw.initialize && raw.tools ? raw : null;
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  try {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
  } catch {
    // Never fatal. A manifest that can't be written costs the NEXT session its
    // laziness; failing the session over it would cost this one its browser.
  }
}

const manifest = manifestPath ? readManifest() : null;

/* ---------------------------------------------------------------- framing */

/** Newline-delimited JSON, which is what MCP's stdio transport is. */
function createLineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}

const writeOut = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/* ------------------------------------------------------ result enrichment */

/** Tool-call ids whose replies may need browser-specific normalization. */
const toolCalls = new Map();

/** MIME type for the formats accepted by Playwright's screenshot tool. */
function screenshotMime(path, requestedType) {
  // Playwright lets `type` override the filename extension, so prefer the
  // validated call argument over a potentially misleading name.
  switch (requestedType?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
  }
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/**
 * Playwright MCP 0.0.79 returns a screenshot as a Markdown link only:
 *
 *   - [Screenshot of viewport](./page.png)
 *
 * That is useful to the model, but MCP clients cannot know the link is media.
 * Add the standard resource_link sibling the broker already knows how to copy
 * into chat assets. The original text stays byte-for-byte for the model.
 */
function enrichScreenshotResult(msg) {
  const call = toolCalls.get(msg.id);
  if (msg.id !== undefined) toolCalls.delete(msg.id);
  if (call?.name !== "browser_take_screenshot" || !msg.result) return msg;

  const content = Array.isArray(msg.result.content) ? msg.result.content : [];
  // A future Playwright release may finally return the bytes/standard link
  // itself. In that case the generic broker path already works, and appending
  // this compatibility reference would show the same screenshot twice.
  if (content.some((b) => b?.type === "image" || b?.type === "resource_link")) return msg;
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  const match = text.match(/^\s*-\s*\[Screenshot[^\]]*\]\((.+)\)\s*$/m);
  if (!match) return msg;

  let named = match[1].trim();
  if (named.startsWith("<") && named.endsWith(">")) named = named.slice(1, -1);
  try {
    const path = named.startsWith("file://")
      ? fileURLToPath(named)
      : isAbsolute(named)
        ? named
        : resolve(ownerDir ?? process.cwd(), named);
    if (!existsSync(path) || !statSync(path).isFile()) return msg;
    const realPath = realpathSync(path);
    return {
      ...msg,
      result: {
        ...msg.result,
        content: [
          ...content,
          {
            type: "resource_link",
            uri: pathToFileURL(realPath).href,
            name: basename(realPath),
            title: "Playwright screenshot",
            mimeType: screenshotMime(realPath, call.arguments?.type),
          },
        ],
      },
    };
  } catch {
    // The browser's own result is still useful even when the file vanished
    // before it could be attached, so enrichment must never fail the call.
    return msg;
  }
}

/* ------------------------------------------------------------ real server */

let child = null;
/** Client frames received while the real server is starting but not yet ready. */
let pending = [];
/** The client's own `initialize` params, replayed to the real server verbatim. */
let clientInitialize = null;
/**
 * The id the client used for `initialize`, when it is still owed an answer.
 *
 * Only ever set on a COLD start. Warm, the manifest already answered it and
 * anything sent under that id later would be a second reply to one request; cold,
 * the real server's handshake result IS the client's answer and this is what
 * says which id to send it back under.
 */
let unansweredInitId = null;
/** Set once the real server has answered our handshake. */
let ready = false;

/**
 * Our own JSON-RPC id for the handshake, in a namespace the client's ids can
 * never collide with: the client owns the integers, so a string id is ours by
 * construction and no mapping table is needed.
 */
const HANDSHAKE_ID = "dispatch-lazy-init";

function spawnReal() {
  if (child) return;
  if (ownerDir) mkdirSync(ownerDir, { recursive: true });
  // `windowsHide` because this runs under a server started detached with no
  // console: without it the browser server — and the Chrome it launches —
  // each pop a window. Every other spawn in this repo sets it.
  child = spawn(realCommand, realArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    // Playwright resolves an explicit screenshot `filename` against cwd even
    // when --output-dir is set. Inheriting Dispatch's cwd leaked captures into
    // the repo as untracked files; the per-chat owner dir is the intended home.
    ...(ownerDir ? { cwd: ownerDir } : {}),
  });

  child.on("error", (err) => {
    // Answer everything outstanding rather than hanging: a client waiting on a
    // response it will never get looks like the browser is thinking, forever.
    for (const frame of pending) failFrame(frame, `browser server failed to start: ${err.message}`);
    pending = [];
    process.exit(1);
  });
  // The shim exists only to front this process; outliving it would leave the
  // session holding a server that answers nothing.
  child.on("exit", (code) => process.exit(code ?? 0));

  createLineReader(child.stdout, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Our handshake's reply is ours to consume — the client already has an
    // `initialize` result (from the manifest, or from this same reply the first
    // time through) and a second one would be a response to a request it never
    // made.
    if (msg.id === HANDSHAKE_ID) {
      ready = true;
      if (msg.result) captureInitialize(msg.result);
      // COLD: this reply is the client's too — it asked, and the manifest had
      // nothing to answer with. Re-addressed to the id it used, because the one
      // on the wire is ours and it never sent a request under it.
      if (unansweredInitId !== null) {
        writeOut({ jsonrpc: "2.0", id: unansweredInitId, ...(msg.result ? { result: msg.result } : { error: msg.error }) });
        unansweredInitId = null;
      }
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      for (const frame of pending) child.stdin.write(JSON.stringify(frame) + "\n");
      pending = [];
      return;
    }
    if (!manifest) captureTools(msg);
    writeOut(enrichScreenshotResult(msg));
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: HANDSHAKE_ID,
      method: "initialize",
      params: clientInitialize,
    }) + "\n",
  );
}

/* ------------------------------------------- manifest capture (cold path) */

let captured = { initialize: null, tools: null };

function captureInitialize(result) {
  captured.initialize = result;
  maybeWriteManifest();
}

/**
 * Catch the real server's `tools/list` answer on its way to the client.
 *
 * Matched by the id the client used, remembered when the request passed
 * through — the response carries no method, so there is nothing else to
 * recognise it by.
 */
const toolsListIds = new Set();
function captureTools(msg) {
  if (msg.id !== undefined && toolsListIds.has(msg.id) && msg.result) {
    toolsListIds.delete(msg.id);
    captured.tools = msg.result;
    maybeWriteManifest();
  }
}

function maybeWriteManifest() {
  if (manifestPath && captured.initialize && captured.tools) {
    writeManifest({ initialize: captured.initialize, tools: captured.tools });
  }
}

/* ----------------------------------------------------------- client side */

function failFrame(frame, message) {
  if (frame.id === undefined) return; // a notification expects no answer
  writeOut({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message } });
}

createLineReader(process.stdin, (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Remember the handshake params whatever else happens — a cold start needs
  // them to spawn with, and a warm one needs them the moment something does.
  if (msg.method === "initialize") clientInitialize = msg.params;
  if (msg.method === "tools/call" && msg.id !== undefined) {
    toolCalls.set(msg.id, { name: msg.params?.name, arguments: msg.params?.arguments });
  }

  if (child) {
    // Already spawned: pure pipe, except that frames arriving mid-handshake
    // have to wait for it rather than racing ahead of `initialize`.
    if (!manifest && msg.method === "tools/list" && msg.id !== undefined) toolsListIds.add(msg.id);
    if (ready) child.stdin.write(line + "\n");
    else pending.push(msg);
    return;
  }

  // Cold: nothing cached, so the real server is the only source of answers.
  if (!manifest) {
    if (msg.method === "initialize") {
      // Answered out of the handshake reply rather than by forwarding this
      // frame — the shim has to do its own `initialize` regardless, and doing
      // both would be two handshakes on one connection.
      unansweredInitId = msg.id ?? null;
      spawnReal();
      return;
    }
    // Ours is sent as part of the handshake, so the client's would be a second
    // one against a server that has already been initialized.
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "tools/list" && msg.id !== undefined) toolsListIds.add(msg.id);
    pending.push(msg);
    spawnReal();
    return;
  }

  // Warm: answer the two questions that don't need a process, and let anything
  // else be the thing that starts one.
  if (msg.method === "initialize") {
    writeOut({ jsonrpc: "2.0", id: msg.id, result: manifest.initialize });
    return;
  }
  if (msg.method === "tools/list") {
    writeOut({ jsonrpc: "2.0", id: msg.id, result: manifest.tools });
    return;
  }
  if (msg.method === "notifications/initialized") return; // replayed on spawn

  pending.push(msg);
  spawnReal();
});

/**
 * How long to let the real server shut itself down before giving up on it.
 *
 * Bounded because this process must not outlive its client either way; long
 * enough that a browser gets to close its pages and release its profile dir.
 */
const GRACEFUL_EXIT_MS = 2_000;

// A closed stdin means the client is gone, and the real server has to go too.
//
// By CLOSING ITS STDIN, not by killing it. `kill()` sends SIGTERM, which on
// Windows is `TerminateProcess` — no handler runs — and Windows does not cascade
// a kill to children. `@playwright/mcp` runs Chrome as a child, so killing the
// server here strands the browser holding its `--isolated` profile dir and its
// debugging port: exactly the orphan this teardown exists to prevent. Stdin EOF
// is the shutdown an MCP stdio server is built around, and it is what the SDK
// does to US. The kill stays only as a bounded fallback for a server that
// ignores it.
process.stdin.on("end", () => {
  if (!child) process.exit(0);
  try {
    child.stdin.end();
  } catch {
    /* already gone */
  }
  const forced = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    process.exit(0);
  }, GRACEFUL_EXIT_MS);
  // `unref` so a server that exits promptly doesn't hold this process open for
  // the rest of the grace window.
  forced.unref?.();
  child.once("exit", () => {
    clearTimeout(forced);
    process.exit(0);
  });
});
