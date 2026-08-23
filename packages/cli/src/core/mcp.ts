/**
 * mcp core — add / list / get / remove / import MCP servers in a project's
 * `.dispatch/project.yaml`.
 *
 * This module is the SINGLE implementation of every MCP config mutation in
 * Dispatch. The `dispatch mcp …` commands are a thin arg-parsing shell over it,
 * and the server's `mcp__dispatch-mcp__mcp_add|mcp_list|mcp_remove` tools call the
 * very same functions — so an agent editing config in-session and a human at the
 * terminal can never drift apart or half-implement each other's validation.
 *
 * Writes are additive and comment-preserving (see `manifest.ts`): adding a server
 * appends one entry to the `mcpServers` sequence and leaves every other node —
 * including comments on sibling servers — untouched.
 */
import { isMap } from "yaml";
import { MANAGER_SERVER_NAMES, MANAGER_SERVER_PREFIX } from "@dispatch/shared";
import {
  ManifestMcpServerSchema,
  ManifestMcpTransportSchema,
  type ManifestMcpServer,
  type ManifestMcpTransport,
} from "@dispatch/shared";
import {
  CmError,
  ensureConfigReadme,
  formatZodIssues,
  loadManifest,
  manifestJs,
  mcpEnabledMap,
  mcpServersSeq,
  saveManifest,
  type ProjectPaths,
} from "./manifest.js";

/** Server names must round-trip as a YAML key and an `mcp__<name>__<tool>` id. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Why a `dispatch-*` name cannot be configured, or null when it's fine. */
function reservedNameReason(name: string): string | null {
  if (!name.startsWith(MANAGER_SERVER_PREFIX)) return null;
  // Dispatch's own servers are merged into a session LAST and win every
  // collision. A project server with one of these names is therefore never
  // handed to a session, cannot be switched off (it reads as always-on), and is
  // dropped from the catalog — so it would sit in project.yaml doing nothing,
  // with the config file as the only place it appeared to exist. Refusing at
  // write time is the one moment that failure can be made visible.
  return (
    `"${name}" is reserved: the \`${MANAGER_SERVER_PREFIX}\` prefix belongs to Dispatch's own ` +
    `tool servers (${MANAGER_SERVER_NAMES.join(", ")}), which are merged last and would ` +
    `silently shadow yours. Pick another name.`
  );
}

/**
 * Reject a name the SDK's `mcp__<server>__<tool>` addressing can't express, or
 * that belongs to Dispatch.
 *
 * Here rather than at either call site because this module is the SINGLE
 * implementation of every MCP config mutation — the `dispatch mcp` commands and
 * the agent's `mcp_add` tool both land on it. A guard on only one of them is the
 * half-implemented validation this file's header warns about, and it shipped
 * exactly that way once.
 */
export function assertValidServerName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new CmError(
      `Invalid server name "${name}". Use letters, digits, "-" and "_" (must start alphanumeric).`,
    );
  }
  const reserved = reservedNameReason(name);
  if (reserved) throw new CmError(reserved);
}

/* ------------------------------------------------------------------ read */

/** Every configured server, in manifest order. Never throws for "no config". */
export async function listServers(cwd: string): Promise<{
  paths: ProjectPaths;
  servers: ManifestMcpServer[];
}> {
  const loaded = await loadManifest(cwd);
  const manifest = manifestJs(loaded.doc);
  return { paths: loaded.paths, servers: manifest?.mcpServers ?? [] };
}

/** One server by name, or null when the project has no such server. */
export async function getServer(
  cwd: string,
  name: string,
): Promise<ManifestMcpServer | null> {
  const { servers } = await listServers(cwd);
  return servers.find((s) => s.name === name) ?? null;
}

/* ----------------------------------------------------------------- write */

/** What an {@link addServer} call did. */
export type AddOutcome = "added" | "replaced";

/** Result of a successful add. */
export interface AddResult {
  outcome: AddOutcome;
  server: ManifestMcpServer;
  paths: ProjectPaths;
}

/**
 * Add (or, with `force`, replace) one server and persist the manifest. Adding a
 * name that already exists FAILS by default — silently overwriting a server a
 * teammate configured is the kind of edit that should be deliberate.
 */
export async function addServer(
  cwd: string,
  input: { name: string; transport: ManifestMcpTransport },
  opts: { force?: boolean } = {},
): Promise<AddResult> {
  assertValidServerName(input.name);
  const parsed = ManifestMcpServerSchema.safeParse(input);
  if (!parsed.success) {
    throw new CmError(`Invalid MCP server definition:\n${formatZodIssues(parsed.error)}`);
  }
  const server = parsed.data;

  const loaded = await loadManifest(cwd);
  const seq = mcpServersSeq(loaded.doc, true);
  const index = indexOfServer(seq.items, server.name);
  let outcome: AddOutcome = "added";
  const node = loaded.doc.createNode(server);
  if (index >= 0) {
    if (!opts.force) {
      throw new CmError(
        `An MCP server named "${server.name}" already exists. ` +
          `Re-run with --force to replace it, or pick another name.`,
      );
    }
    seq.items[index] = node;
    outcome = "replaced";
  } else {
    seq.items.push(node);
  }
  await saveManifest(loaded);
  if (!loaded.existed) await ensureConfigReadme(loaded.paths.configDir);
  return { outcome, server, paths: loaded.paths };
}

/**
 * Remove a server by name. Returns false when there was nothing to remove (the
 * caller decides whether that's an error) and never writes in that case.
 */
export async function removeServer(
  cwd: string,
  name: string,
): Promise<{ removed: boolean; paths: ProjectPaths }> {
  const loaded = await loadManifest(cwd);
  const seq = mcpServersSeq(loaded.doc);
  if (!seq) return { removed: false, paths: loaded.paths };
  const index = indexOfServer(seq.items, name);
  if (index < 0) return { removed: false, paths: loaded.paths };
  seq.items.splice(index, 1);
  // Drop the key entirely once the last server goes, rather than leaving a
  // dangling `mcpServers: []` the schema tolerates but nobody wants to read.
  if (seq.items.length === 0) loaded.doc.delete("mcpServers");
  await saveManifest(loaded);
  return { removed: true, paths: loaded.paths };
}

/* ------------------------------------------------------------ enablement */

/**
 * Pin a server on or off in this project's `mcpEnabled` map, or clear the pin.
 *
 * Separate from add/remove on purpose: switching a server off should not delete
 * how it was configured, and switching one ON has to work for a BUNDLED server
 * that has no `mcpServers` entry to edit in the first place. So the name here is
 * deliberately unvalidated against the declared list — `playwright` is a legal
 * target in a manifest that never mentions it.
 *
 * `enabled: null` removes the pin (back to inheriting the app layer, then the
 * server's own default), and the `mcpEnabled` key goes with the last pin rather
 * than lingering as an empty map.
 */
export async function setServerEnabled(
  cwd: string,
  name: string,
  enabled: boolean | null,
): Promise<{ changed: boolean; paths: ProjectPaths }> {
  assertValidServerName(name);
  const loaded = await loadManifest(cwd);

  if (enabled === null) {
    const map = mcpEnabledMap(loaded.doc);
    if (!map?.has(name)) return { changed: false, paths: loaded.paths };
    map.delete(name);
    if (map.items.length === 0) loaded.doc.delete("mcpEnabled");
    await saveManifest(loaded);
    return { changed: true, paths: loaded.paths };
  }

  const map = mcpEnabledMap(loaded.doc, true);
  if (map.get(name) === enabled) return { changed: false, paths: loaded.paths };
  map.set(name, enabled);
  await saveManifest(loaded);
  if (!loaded.existed) await ensureConfigReadme(loaded.paths.configDir);
  return { changed: true, paths: loaded.paths };
}

/** Locate a server entry in a raw YAML sequence by its `name` scalar. */
function indexOfServer(items: readonly unknown[], name: string): number {
  return items.findIndex((item) => {
    if (isMap(item)) return item.get("name") === name;
    return (item as { name?: unknown } | null)?.name === name;
  });
}

/* ---------------------------------------------------------------- import */

/**
 * The `{ "mcpServers": { … } }` shape used by `.mcp.json`, Claude Desktop's
 * `claude_desktop_config.json`, `~/.claude.json`, and most published MCP install
 * snippets. Deliberately permissive — a real-world file carries extra keys we
 * simply ignore.
 */
export interface McpJsonShape {
  mcpServers?: Record<string, unknown>;
}

/** One server's outcome in an {@link importServers} run. */
export interface ImportEntry {
  name: string;
  status: "added" | "replaced" | "skipped" | "invalid";
  /** Populated for `skipped` (already exists) and `invalid` (why it was rejected). */
  reason?: string;
}

/**
 * Import every server from a parsed `{ mcpServers: { … } }` object. Each entry is
 * converted to a manifest transport and added; a name that already exists is
 * SKIPPED unless `force` is set, and an entry that can't be understood is
 * reported `invalid` without aborting the rest — importing 9 good servers out of
 * 10 beats failing the whole file over one bad line.
 */
export async function importServers(
  cwd: string,
  source: McpJsonShape,
  opts: { force?: boolean } = {},
): Promise<{ entries: ImportEntry[]; paths: ProjectPaths }> {
  const raw = source?.mcpServers;
  if (!raw || typeof raw !== "object") {
    throw new CmError('No "mcpServers" object found in the source file.');
  }

  const loaded = await loadManifest(cwd);
  const seq = mcpServersSeq(loaded.doc, true);
  const entries: ImportEntry[] = [];
  let dirty = false;

  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      entries.push({ name, status: "invalid", reason: "unusable server name" });
      continue;
    }
    const reserved = reservedNameReason(name);
    if (reserved) {
      // Skipped rather than thrown: an import is a batch, and one reserved name
      // in somebody's `.mcp.json` shouldn't discard the other nine.
      entries.push({ name, status: "invalid", reason: reserved });
      continue;
    }
    let transport: ManifestMcpTransport;
    try {
      transport = mcpJsonEntryToTransport(value);
    } catch (err) {
      entries.push({
        name,
        status: "invalid",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const index = indexOfServer(seq.items, name);
    if (index >= 0 && !opts.force) {
      entries.push({ name, status: "skipped", reason: "already configured" });
      continue;
    }
    const node = loaded.doc.createNode({ name, transport });
    if (index >= 0) {
      seq.items[index] = node;
      entries.push({ name, status: "replaced" });
    } else {
      seq.items.push(node);
      entries.push({ name, status: "added" });
    }
    dirty = true;
  }

  if (dirty) {
    await saveManifest(loaded);
    if (!loaded.existed) await ensureConfigReadme(loaded.paths.configDir);
  }
  return { entries, paths: loaded.paths };
}

/**
 * Convert one `.mcp.json`-style server value into a manifest transport. Handles
 * the two conventions in the wild: an explicit `"type"` field, and the older
 * implicit form where the presence of `command` vs `url` decides the transport.
 */
export function mcpJsonEntryToTransport(value: unknown): ManifestMcpTransport {
  if (!value || typeof value !== "object") {
    throw new CmError("expected an object");
  }
  const v = value as Record<string, unknown>;
  const declared = typeof v.type === "string" ? v.type : undefined;
  const kind = declared ?? (typeof v.command === "string" ? "stdio" : v.url ? "http" : undefined);

  if (kind === "stdio") {
    if (typeof v.command !== "string" || !v.command) throw new CmError("stdio entry has no command");
    return ManifestMcpTransportSchema.parse({
      type: "stdio",
      command: v.command,
      ...(Array.isArray(v.args) ? { args: v.args.map(String) } : {}),
      ...(isStringRecord(v.env) ? { env: v.env } : {}),
    });
  }
  if (kind === "http" || kind === "sse") {
    if (typeof v.url !== "string" || !v.url) throw new CmError(`${kind} entry has no url`);
    return ManifestMcpTransportSchema.parse({
      type: kind,
      url: v.url,
      ...(isStringRecord(v.headers) ? { headers: v.headers } : {}),
    });
  }
  throw new CmError(
    `unrecognized transport${declared ? ` "${declared}"` : ""} — expected stdio, http, or sse`,
  );
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

/* --------------------------------------------------------------- display */

/** A one-line human summary of a transport, e.g. `stdio: npx -y mcp-ripgrep`. */
export function describeTransport(transport: ManifestMcpTransport): string {
  if (transport.type === "stdio") {
    const argv = [transport.command, ...(transport.args ?? [])].join(" ");
    const env = transport.env ? ` (env: ${Object.keys(transport.env).join(", ")})` : "";
    return `stdio: ${argv}${env}`;
  }
  const headers = transport.headers
    ? ` (headers: ${Object.keys(transport.headers).join(", ")})`
    : "";
  return `${transport.type}: ${transport.url}${headers}`;
}
