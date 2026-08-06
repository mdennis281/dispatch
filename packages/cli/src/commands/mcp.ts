/**
 * `dispatch mcp …` — the terminal face of the MCP config core.
 *
 * Every command here is a thin shell: parse flags, call one `core/mcp.ts`
 * function, print the result. Two output modes are supported throughout —
 * human-readable by default, and `--json` for scripts and for agents that would
 * rather parse than scrape. Failures throw {@link CmError}; the top-level
 * entrypoint turns those into a clean one-line message + exit 1, so no command
 * ever prints a stack trace at a user.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { ManifestMcpServer } from "@dispatch/shared";
import { referencedEnvVars } from "@dispatch/shared";
import {
  addServer,
  describeTransport,
  getServer,
  importServers,
  listServers,
  removeServer,
  type ImportEntry,
} from "../core/mcp.js";
import { CmError, loadManifest, saveManifest, resolveProjectPaths } from "../core/manifest.js";
import { all, flag, has, parseArgs, transportFromArgs, type ParsedArgs } from "../core/args.js";

/** Where an invocation should look for the project (`--dir`, else cwd). */
function targetDir(args: ParsedArgs): string {
  return resolve(flag(args, "dir") ?? process.cwd());
}

/** Print JSON when `--json` was passed. Returns whether it handled the output. */
function emitJson(args: ParsedArgs, payload: unknown): boolean {
  if (!has(args, "json")) return false;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

/** Path shown in messages: relative to cwd when that's shorter to read. */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/**
 * Warn about `${VAR}` placeholders that aren't set in the CURRENT environment.
 * Not an error — the manager server is what expands them at session launch, and
 * it may well have a variable this shell doesn't.
 */
function warnUnsetPlaceholders(server: ManifestMcpServer): void {
  const strings: string[] = [];
  const t = server.transport;
  if (t.type === "stdio") {
    strings.push(t.command, ...(t.args ?? []), ...Object.values(t.env ?? {}));
  } else {
    strings.push(t.url, ...Object.values(t.headers ?? {}));
  }
  const missing = [...new Set(strings.flatMap(referencedEnvVars))].filter(
    (name) => !process.env[name],
  );
  if (!missing.length) return;
  process.stderr.write(
    `  note: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in this shell — ` +
      `set ${missing.length === 1 ? "it" : "them"} where Dispatch runs.\n`,
  );
}

/* -------------------------------------------------------------------- add */

async function cmdAdd(args: ParsedArgs): Promise<void> {
  const [name, ...rest] = args.positionals;
  if (!name) throw new CmError("Usage: dispatch mcp add <name> -- <command> [args...]");
  const transport = transportFromArgs(args, rest);
  const result = await addServer(targetDir(args), { name, transport }, { force: has(args, "force") });

  if (emitJson(args, { ok: true, outcome: result.outcome, server: result.server })) return;
  const verb = result.outcome === "replaced" ? "Replaced" : "Added";
  process.stdout.write(
    `${verb} MCP server "${name}" in ${displayPath(result.paths.manifestPath)}\n` +
      `  ${describeTransport(transport)}\n`,
  );
  warnUnsetPlaceholders(result.server);
  process.stdout.write(
    "  Sessions in this project pick it up automatically — no restart needed.\n",
  );
}

/* --------------------------------------------------------------- add-json */

async function cmdAddJson(args: ParsedArgs): Promise<void> {
  const [name, json] = args.positionals;
  if (!name || !json) {
    throw new CmError(`Usage: dispatch mcp add-json <name> '{"command":"npx","args":["-y","pkg"]}'`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new CmError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Reuse the import converter so `add-json` accepts exactly the same server
  // shape as `dispatch mcp import` — one definition of "what a server object is".
  const { mcpJsonEntryToTransport } = await import("../core/mcp.js");
  const transport = mcpJsonEntryToTransport(value);
  const result = await addServer(targetDir(args), { name, transport }, { force: has(args, "force") });

  if (emitJson(args, { ok: true, outcome: result.outcome, server: result.server })) return;
  const verb = result.outcome === "replaced" ? "Replaced" : "Added";
  process.stdout.write(
    `${verb} MCP server "${name}" in ${displayPath(result.paths.manifestPath)}\n` +
      `  ${describeTransport(transport)}\n`,
  );
  warnUnsetPlaceholders(result.server);
}

/* ------------------------------------------------------------------- list */

async function cmdList(args: ParsedArgs): Promise<void> {
  const { paths, servers } = await listServers(targetDir(args));
  if (emitJson(args, { manifest: paths.manifestPath, servers })) return;

  if (!servers.length) {
    process.stdout.write(
      `No MCP servers configured in ${displayPath(paths.manifestPath)}\n` +
        `  Add one:  dispatch mcp add <name> -- <command> [args...]\n`,
    );
    return;
  }
  process.stdout.write(`${servers.length} MCP server(s) in ${displayPath(paths.manifestPath)}:\n`);
  for (const server of servers) {
    process.stdout.write(`  ${server.name.padEnd(20)} ${describeTransport(server.transport)}\n`);
  }
}

/* -------------------------------------------------------------------- get */

async function cmdGet(args: ParsedArgs): Promise<void> {
  const [name] = args.positionals;
  if (!name) throw new CmError("Usage: dispatch mcp get <name>");
  const server = await getServer(targetDir(args), name);
  if (!server) throw new CmError(`No MCP server named "${name}" in this project.`);
  if (emitJson(args, server)) return;

  const t = server.transport;
  process.stdout.write(`${server.name}\n  transport: ${t.type}\n`);
  if (t.type === "stdio") {
    process.stdout.write(`  command:   ${[t.command, ...(t.args ?? [])].join(" ")}\n`);
    for (const [k, v] of Object.entries(t.env ?? {})) {
      process.stdout.write(`  env:       ${k}=${v}\n`);
    }
  } else {
    process.stdout.write(`  url:       ${t.url}\n`);
    for (const [k, v] of Object.entries(t.headers ?? {})) {
      process.stdout.write(`  header:    ${k}: ${v}\n`);
    }
  }
  process.stdout.write(`  tools:     visible in the manager UI (MCP catalog → ${server.name})\n`);
}

/* ----------------------------------------------------------------- remove */

async function cmdRemove(args: ParsedArgs): Promise<void> {
  const [name] = args.positionals;
  if (!name) throw new CmError("Usage: dispatch mcp remove <name>");
  const { removed, paths } = await removeServer(targetDir(args), name);
  if (emitJson(args, { ok: removed, name })) return;
  if (!removed) throw new CmError(`No MCP server named "${name}" to remove.`);
  process.stdout.write(`Removed MCP server "${name}" from ${displayPath(paths.manifestPath)}\n`);
}

/* ----------------------------------------------------------------- import */

/** Well-known files to try, in order, when `dispatch mcp import` is given no path. */
function importCandidates(dir: string): string[] {
  const home = homedir();
  return [
    join(dir, ".mcp.json"),
    join(dir, ".vscode", "mcp.json"),
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    join(home, ".config", "Claude", "claude_desktop_config.json"),
    join(home, ".claude.json"),
  ];
}

async function cmdImport(args: ParsedArgs): Promise<void> {
  const dir = targetDir(args);
  const [explicit] = args.positionals;
  const source = explicit
    ? resolve(explicit)
    : importCandidates(dir).find((candidate) => existsSync(candidate));
  if (!source) {
    throw new CmError(
      "Nothing to import — pass a file explicitly:\n" +
        "  dispatch mcp import ./.mcp.json\n" +
        "Looked for .mcp.json, .vscode/mcp.json, and the Claude Desktop config.",
    );
  }
  if (!existsSync(source)) throw new CmError(`No such file: ${source}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (err) {
    throw new CmError(
      `Could not read ${displayPath(source)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { entries, paths } = await importServers(dir, parsed as { mcpServers?: Record<string, unknown> }, {
    force: has(args, "force"),
  });
  if (emitJson(args, { source, manifest: paths.manifestPath, entries })) return;

  const count = (status: ImportEntry["status"]): number =>
    entries.filter((e) => e.status === status).length;
  process.stdout.write(
    `Imported from ${displayPath(source)} → ${displayPath(paths.manifestPath)}\n`,
  );
  for (const entry of entries) {
    const suffix = entry.reason ? ` (${entry.reason})` : "";
    process.stdout.write(`  ${entry.status.padEnd(9)} ${entry.name}${suffix}\n`);
  }
  const skipped = count("skipped");
  if (skipped) {
    process.stdout.write(`  ${skipped} skipped — re-run with --force to overwrite.\n`);
  }
}

/* ------------------------------------------------------------------- init */

async function cmdInit(args: ParsedArgs): Promise<void> {
  const dir = targetDir(args);
  const paths = resolveProjectPaths(dir);
  if (paths.exists) {
    process.stdout.write(`Already initialized: ${displayPath(paths.manifestPath)}\n`);
    return;
  }
  const loaded = await loadManifest(dir);
  const written = await saveManifest(loaded);
  const { ensureConfigReadme } = await import("../core/manifest.js");
  await ensureConfigReadme(loaded.paths.configDir);
  if (emitJson(args, { ok: true, manifest: written })) return;
  process.stdout.write(
    `Created ${displayPath(written)}\n` +
      `  Next:  dispatch mcp add <name> -- <command> [args...]\n`,
  );
}

/* --------------------------------------------------------------- dispatch */

export const MCP_HELP = `dispatch mcp — manage this project's MCP servers (.dispatch/project.yaml)

Usage:
  dispatch mcp add <name> [options] -- <command> [args...]   Add a stdio (subprocess) server
  dispatch mcp add <name> --transport http --url <url>       Add a remote HTTP/SSE server
  dispatch mcp add-json <name> '<json>'                      Add from a README's JSON snippet
  dispatch mcp list                                          List configured servers
  dispatch mcp get <name>                                    Show one server in full
  dispatch mcp remove <name>                                 Remove a server
  dispatch mcp import [file]                                 Import from .mcp.json / Claude Desktop
  dispatch mcp init                                          Scaffold .dispatch/project.yaml

Options:
  -t, --transport <stdio|http|sse>  Transport (default: stdio, or http when --url is given)
      --url <url>                   Endpoint for http/sse servers
  -e, --env KEY=VALUE               Env var for a stdio server (repeatable)
  -H, --header "Key: Value"         Header for an http/sse server (repeatable)
  -f, --force                       Overwrite a server that already exists
  -C, --dir <path>                  Project directory (default: cwd, walking up to the repo root)
      --json                        Machine-readable output

Secrets:
  Values may contain \${VAR} or \${VAR:-default} placeholders, expanded from the
  environment Dispatch runs in. Keep real keys out of the committed file:

  dispatch mcp add linear --transport http --url https://mcp.linear.app/mcp \\
    -H "Authorization: Bearer \${LINEAR_API_KEY}"

Examples:
  dispatch mcp add ripgrep -- npx -y mcp-ripgrep@latest
  dispatch mcp add postgres -e DATABASE_URL=\${DATABASE_URL} -- npx -y @modelcontextprotocol/server-postgres
  dispatch mcp add sentry --transport sse --url https://mcp.sentry.dev/sse
  dispatch mcp import ./.mcp.json
`;

/** Route a `dispatch mcp <sub> …` invocation. */
export async function runMcpCommand(argv: readonly string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(MCP_HELP);
    return;
  }
  const args = parseArgs(rest);
  if (has(args, "help")) {
    process.stdout.write(MCP_HELP);
    return;
  }

  switch (sub) {
    case "add":
      return cmdAdd(args);
    case "add-json":
      return cmdAddJson(args);
    case "list":
    case "ls":
      return cmdList(args);
    case "get":
    case "show":
      return cmdGet(args);
    case "remove":
    case "rm":
    case "delete":
      return cmdRemove(args);
    case "import":
      return cmdImport(args);
    case "init":
      return cmdInit(args);
    default:
      throw new CmError(`Unknown command "dispatch mcp ${sub}". Run \`dispatch mcp help\` for usage.`);
  }
}

/** Exposed for tests: the flag surface without the fs side effects. */
export { all, flag, has };
