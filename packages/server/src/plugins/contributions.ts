/**
 * Plugin CONTRIBUTIONS — the static things a plugin ships beside its code:
 * modes, skills, instructions, personas, MCP servers and managed processes.
 * See docs/plugins.md → "Contributions".
 *
 * Everything here is a READER over a plugin directory plus a couple of pure
 * selectors; none of it touches a service. `PluginService` snapshots a plugin's
 * contributions once at `load()` (hot reload is out of scope — changing a
 * plugin means restarting the server) and the authored-config service, the
 * broker, the catalog and the mode editor consume the snapshot through the
 * narrow interfaces each of them declares.
 *
 * Three rules this file is the chokepoint for:
 *
 *   - A plugin MCP server's default `cwd` is the PLUGIN DIRECTORY. A project
 *     server defaults to the chat's own tree because that is the isolation;
 *     code that ships inside the plugin would never be found from there.
 *   - A plugin server name goes through the SAME `assertValidServerName` a
 *     project name does, so `dispatch-*` is refused in this new place a name
 *     can be declared, exactly as the spec's inherited rules demand.
 *   - `${secret:NAME}` expands only for names the manifest lists under
 *     `secrets:`. An unlisted name is blanked, not left in place: anything
 *     left as a placeholder would be expanded a moment later by the project's
 *     own resolver, which hands the plugin a secret it never declared.
 */
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { assertValidServerName } from "@dispatch/cli/core";
import {
  PluginMcpServersFileSchema,
  PluginProcessesFileSchema,
  expandEnvList,
  expandEnvRecord,
  expandEnvVars,
  referencedSecrets,
  resolveMcpEnablement,
  type McpEnablementLayers,
  type McpServerConfig,
  type ModeConfig,
  type PluginManifest,
  type PluginProcess,
  type SkillConfig,
} from "@dispatch/shared";
import { readInstructionsDir, readSkillsDir, type InstructionFile } from "../services/authored-config.js";
import { readModesDir } from "../services/mcp/mode-editor.js";

/** One MCP server a plugin declared, with the placeholders still in it. */
export interface PluginMcpDeclaration {
  name: string;
  pluginId: string;
  /** `cwd` already stamped to the plugin dir (or its override, resolved against it). */
  config: McpServerConfig;
  /**
   * The enablement DEFAULT — the plugin's own toggle. A disabled plugin's
   * server is still declared (the catalog lists it, switched off) so the usual
   * `mcpEnabled` layers can reason about it; an `mcpEnabled` pin outranks this
   * exactly as it outranks the browser auto-gate.
   */
  byDefault: boolean;
  defaultReason: string;
  /** Secret names the manifest lists — the only ones `${secret:…}` may expand. */
  secrets: readonly string[];
}

/** A plugin's declared managed process, with the directory it resolves against. */
export interface PluginProcessDeclaration {
  pluginId: string;
  dir: string;
  spec: PluginProcess;
}

/** What one plugin contributes, as read from its directory. */
export interface PluginContributions {
  skills: SkillConfig[];
  instructions: InstructionFile[];
  personas: InstructionFile[];
  modes: ModeConfig[];
  mcpServers: Array<Omit<PluginMcpDeclaration, "byDefault" | "defaultReason">>;
  processes: PluginProcess[];
  /** Non-fatal problems: each names the contribution that was dropped and why. */
  warnings: string[];
}

export const EMPTY_CONTRIBUTIONS: PluginContributions = Object.freeze({
  skills: [],
  instructions: [],
  personas: [],
  modes: [],
  mcpServers: [],
  processes: [],
  warnings: [],
}) as PluginContributions;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse one YAML contribution file, or `null` (with a warning) when it is missing or malformed. */
function readYamlFile(dir: string, rel: string, what: string, warnings: string[]): unknown {
  const path = resolve(dir, rel);
  if (!existsSync(path)) {
    warnings.push(`${what}: ${rel} does not exist`);
    return null;
  }
  try {
    return parseYaml(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    warnings.push(`${what}: ${rel} is not valid YAML: ${describe(err)}`);
    return null;
  }
}

/**
 * Read every contribution the manifest names. Never throws: a broken file is a
 * warning on the plugin row and an empty list, because a plugin whose `mcp.yaml`
 * has a typo should still get its skills injected and its server activated.
 */
export async function readPluginContributions(
  pluginId: string,
  dir: string,
  manifest: PluginManifest,
): Promise<PluginContributions> {
  const c = manifest.contributes;
  if (!c) return EMPTY_CONTRIBUTIONS;
  const warnings: string[] = [];
  const caps = new Set(manifest.capabilities ?? []);

  const skills = c.skills ? readSkillsDir(resolve(dir, c.skills)) : [];
  const instructions = c.instructions ? await readInstructionsDir(resolve(dir, c.instructions)) : [];
  const personas = c.personas ? await readInstructionsDir(resolve(dir, c.personas)) : [];
  const modes = c.modes
    ? (await readModesDir(resolve(dir, c.modes))).map(
        (m): ModeConfig => ({
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          permissionMode: m.permissionMode,
          ...(m.allowedTools ? { allowedTools: m.allowedTools } : {}),
          ...(m.disallowedTools ? { disallowedTools: m.disallowedTools } : {}),
          ...(m.autoAllowTools ? { autoAllowTools: m.autoAllowTools } : {}),
          ...(m.instructions ? { instructions: m.instructions } : {}),
          scope: "plugin",
          pluginId,
        }),
      )
    : [];

  // Capability-gated, like the context members they pair with: a manifest
  // that declares `contributes.mcpServers` without `mcp` in `capabilities` is
  // telling the consent card one thing and the host another. The declaration
  // wins — nothing runs — and the row says why.
  let mcpServers: PluginContributions["mcpServers"] = [];
  if (c.mcpServers) {
    if (!caps.has("mcp")) {
      warnings.push(`contributes.mcpServers is ignored: the manifest does not declare the "mcp" capability`);
    } else {
      mcpServers = readMcpServersFile(pluginId, dir, c.mcpServers, manifest.secrets ?? [], warnings);
    }
  }
  let processes: PluginProcess[] = [];
  if (c.processes) {
    if (!caps.has("process")) {
      warnings.push(`contributes.processes is ignored: the manifest does not declare the "process" capability`);
    } else {
      processes = readProcessesFile(dir, c.processes, warnings);
    }
  }

  return { skills, instructions, personas, modes, mcpServers, processes, warnings };
}

/* ---------------------------------------------------------------- mcp.yaml */

function readMcpServersFile(
  pluginId: string,
  dir: string,
  rel: string,
  secrets: readonly string[],
  warnings: string[],
): PluginContributions["mcpServers"] {
  const doc = readYamlFile(dir, rel, "contributes.mcpServers", warnings);
  if (doc === null) return [];
  const parsed = PluginMcpServersFileSchema.safeParse(doc);
  if (!parsed.success) {
    warnings.push(
      `contributes.mcpServers: ${rel}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
    return [];
  }
  const out: PluginContributions["mcpServers"] = [];
  const seen = new Set<string>();
  for (const server of parsed.data) {
    try {
      // The same chokepoint `mcp_add` and `dispatch mcp add` go through, so the
      // reserved `dispatch-` prefix is refused here with the same sentence.
      assertValidServerName(server.name);
    } catch (err) {
      warnings.push(`contributes.mcpServers: ${describe(err)}`);
      continue;
    }
    if (seen.has(server.name)) {
      warnings.push(`contributes.mcpServers: "${server.name}" is declared twice; the first wins`);
      continue;
    }
    seen.add(server.name);
    const missing = new Set<string>();
    const config = transportToConfig(dir, server, missing);
    if (missing.size) {
      warnings.push(
        `MCP server "${server.name}" references unset environment variable(s): ${[...missing].join(", ")}`,
      );
    }
    // Checked up front so the owner learns about an undeclared secret from the
    // plugin row, not from a server that starts with an empty token.
    // EVERY string the runtime config carries — `cwd` and `prewarm` included.
    // `expandSecretsInMcpServers` (the project resolver, applied to the merged
    // record a moment later) expands both, so a field left out of this scan
    // and out of `expandDeclaration` below is a field through which a plugin
    // reads a project secret it never declared.
    const refs = new Set<string>();
    for (const v of secretBearingStrings(config)) for (const n of referencedSecrets(v)) refs.add(n);
    const undeclared = [...refs].filter((n) => !secrets.includes(n));
    if (undeclared.length) {
      warnings.push(
        `MCP server "${server.name}" references secret(s) the manifest does not list under secrets: ` +
          `${undeclared.join(", ")} — they expand to an empty string`,
      );
    }
    out.push({ name: server.name, pluginId, config, secrets });
  }
  return out;
}

/**
 * Manifest transport → runtime config, mirroring `project-config.ts`'s
 * `transportToMcpConfig` (which is private to the project loader on purpose:
 * its defaults are a project's). `${VAR}` expands from the manager's
 * environment; `${secret:NAME}` stays a placeholder until the hand-off.
 */
function transportToConfig(
  dir: string,
  server: { transport: Record<string, unknown> & { type: string }; ports?: number; portRange?: [number, number]; prewarm?: string },
  missing: Set<string>,
): McpServerConfig {
  const opts = { onMissing: (name: string) => missing.add(name) };
  const str = (v: unknown): string | undefined => (typeof v === "string" ? expandEnvVars(v, opts) : undefined);
  const t = server.transport;
  const extras = {
    ...(server.ports !== undefined ? { ports: server.ports } : {}),
    ...(server.portRange !== undefined ? { portRange: server.portRange } : {}),
    ...(server.prewarm !== undefined ? { prewarm: str(server.prewarm) } : {}),
  };
  if (t.type === "stdio") {
    const cwd = str(t.cwd);
    return {
      type: "stdio",
      command: str(t.command),
      args: expandEnvList(t.args as string[] | undefined, opts),
      env: expandEnvRecord(t.env as Record<string, string> | undefined, opts),
      // ALWAYS absolute and ALWAYS inside (or relative to) the plugin dir. An
      // explicit relative `cwd` is the plugin pointing at its own subdirectory,
      // not at the chat's tree — so it resolves against the plugin, never the
      // session cwd the broker would otherwise stamp.
      cwd: cwd ? resolve(dir, cwd) : dir,
      ...extras,
    };
  }
  return {
    type: t.type as "http" | "sse",
    url: str(t.url),
    headers: expandEnvRecord(t.headers as Record<string, string> | undefined, opts),
    ...extras,
  };
}

/* ---------------------------------------------------------- processes.yaml */

function readProcessesFile(dir: string, rel: string, warnings: string[]): PluginProcess[] {
  const doc = readYamlFile(dir, rel, "contributes.processes", warnings);
  if (doc === null) return [];
  const parsed = PluginProcessesFileSchema.safeParse(doc);
  if (!parsed.success) {
    warnings.push(
      `contributes.processes: ${rel}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
    return [];
  }
  const out: PluginProcess[] = [];
  const seen = new Set<string>();
  for (const p of parsed.data) {
    if (seen.has(p.id)) {
      warnings.push(`contributes.processes: "${p.id}" is declared twice; the first wins`);
      continue;
    }
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------- selectors */

/**
 * `${secret:NAME}` for a PLUGIN'S server: listed names resolve through the
 * store, anything else becomes "" (see the module note for why not a
 * placeholder). `onRefused` is called once per unlisted name so the broker can
 * say so in its log.
 */
export function expandPluginSecrets(
  value: string,
  allowed: readonly string[],
  lookup: (name: string) => string | undefined,
  onRefused?: (name: string) => void,
): string {
  return value.replace(/\$\{secret:([A-Za-z_][A-Za-z0-9_]{0,63})\}/g, (_m, name: string) => {
    if (!allowed.includes(name)) {
      onRefused?.(name);
      return "";
    }
    return lookup(name) ?? "";
  });
}

/** The string fields of a server config a `${secret:…}` can hide in — the same set `expandSecretsInMcpServers` expands. */
const SECRET_STRING_KEYS = ["command", "url", "cwd", "prewarm"] as const;
const SECRET_RECORD_KEYS = ["env", "headers"] as const;

function secretBearingStrings(config: McpServerConfig): string[] {
  const c = config as McpServerConfig & Record<string, unknown>;
  const out: string[] = [];
  for (const k of SECRET_STRING_KEYS) if (typeof c[k] === "string") out.push(c[k] as string);
  if (Array.isArray(c.args)) out.push(...(c.args as string[]));
  for (const k of SECRET_RECORD_KEYS) if (c[k]) out.push(...Object.values(c[k] as Record<string, string>));
  return out;
}

/**
 * Fill a declaration's secrets. Mirrors `expandSecretsInMcpServers` FIELD FOR
 * FIELD (command, args, env, headers, url, cwd, prewarm): that function runs
 * on the merged record right after this one with the PROJECT resolver, so any
 * field this skips is one it would fill from secrets the plugin never listed.
 */
function expandDeclaration(
  decl: PluginMcpDeclaration,
  lookup: (name: string) => string | undefined,
  onRefused?: (plugin: string, server: string, name: string) => void,
): McpServerConfig {
  const refused = (n: string) => onRefused?.(decl.pluginId, decl.name, n);
  const one = (v: string) => expandPluginSecrets(v, decl.secrets, lookup, refused);
  const c = decl.config as McpServerConfig & Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  for (const k of SECRET_STRING_KEYS) if (typeof c[k] === "string") out[k] = one(c[k] as string);
  if (Array.isArray(c.args)) out.args = (c.args as string[]).map(one);
  for (const k of SECRET_RECORD_KEYS) {
    if (c[k]) out[k] = Object.fromEntries(Object.entries(c[k] as Record<string, string>).map(([key, v]) => [key, one(v)]));
  }
  return out as McpServerConfig;
}

/**
 * The plugin servers ONE session (or one catalog view) actually gets: each
 * declaration resolved through the four `mcpEnabled` layers over its own
 * default, with secrets filled in — the moment of hand-off, as for project
 * servers. Pure, so the broker's two sites (session build and live reload)
 * and the catalog route can share it and cannot drift.
 *
 * Two plugins declaring one name: the first by plugin id wins, which is the
 * order plugins activate in. Reported by the loader, decided here.
 */
export function selectPluginMcpServers(
  declarations: readonly PluginMcpDeclaration[],
  layers: McpEnablementLayers | undefined,
  secretLookup?: (name: string) => string | undefined,
  onRefusedSecret?: (plugin: string, server: string, name: string) => void,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const decl of declarations) {
    if (decl.name in out) continue;
    if (!resolveMcpEnablement(decl.name, layers, decl.byDefault).effective) continue;
    out[decl.name] = secretLookup
      ? expandDeclaration(decl, secretLookup, onRefusedSecret)
      : expandDeclaration(decl, () => undefined, onRefusedSecret);
  }
  return out;
}

/**
 * Compose the session's declared `mcpServers` record in precedence order —
 * lowest first, so a later spread shadows an earlier one by name:
 *
 *   bundled browser pair  <  plugin servers  <  project `.data` record  <  project `.dispatch/` config
 *
 * Dispatch's own `dispatch-*` category servers are spread over the result by
 * the caller and win every collision. One function for both broker sites
 * (`buildOptions` and `refreshMcpServers`), because the first time this
 * project had two merge sites one of them silently dropped a layer.
 */
export function mergeDeclaredMcpServers<T>(layers: {
  bundled?: Record<string, T>;
  plugin?: Record<string, T>;
  project?: Record<string, T>;
  config?: Record<string, T>;
}): Record<string, T> {
  return { ...(layers.bundled ?? {}), ...(layers.plugin ?? {}), ...(layers.project ?? {}), ...(layers.config ?? {}) };
}

/** `plugin:<id>` — the runner `owner` a plugin's processes carry. */
export function pluginProcessOwner(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** The plugin id behind a runner `owner`, or null when it is not a plugin's. */
export function pluginIdOfOwner(owner: string | undefined): string | null {
  return owner?.startsWith("plugin:") ? owner.slice("plugin:".length) : null;
}

/** Where the contribution dirs of a plugin are, absolute — for `config_list` paths. */
export function contributionDir(dir: string, rel: string | undefined): string | undefined {
  return rel ? join(dir, rel) : undefined;
}
