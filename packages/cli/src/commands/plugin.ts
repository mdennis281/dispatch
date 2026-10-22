/**
 * `cm plugin …` — install and manage plugins under `<configDir>/plugins/`.
 *
 * Thin shells over `core/plugins.ts`, like `mcp.ts` is over `core/mcp.ts`:
 * parse flags, call one function, print. `--json` for scripts and agents.
 *
 * The config root is the one thing every command needs and the one thing the
 * CLI cannot discover on its own: it is wherever the running server was told
 * to keep it. `--config-dir` wins, then `DISPATCH_CONFIG_DIR` (or the
 * pre-rename `CM_CONFIG_DIR`), then `DISPATCH_DATA_DIR` for the single-root
 * layout a source checkout runs with.
 */
import { resolve } from "node:path";
import { PLUGIN_API_VERSION } from "@dispatch/shared";
import {
  addPlugin,
  consentLines,
  discoverPlugins,
  linkPlugin,
  pluginsRoot,
  readPluginToggles,
  removePlugin,
  setPluginEnabled,
} from "../core/plugins.js";
import { initPlugin, type PluginScaffoldKind } from "../core/plugin-init.js";
import { CmError } from "../core/manifest.js";
import { flag, has, parseArgs, type ParsedArgs } from "../core/args.js";

function configDirOf(args: ParsedArgs): string {
  const env = process.env;
  const dir =
    flag(args, "config-dir") ??
    env.DISPATCH_CONFIG_DIR ??
    env.CM_CONFIG_DIR ??
    env.DISPATCH_DATA_DIR ??
    env.CM_DATA_DIR;
  if (!dir) {
    throw new CmError(
      "Where is Dispatch's config directory? Pass --config-dir <dir> or set DISPATCH_CONFIG_DIR.\n" +
        "  The installed app's is shown under Settings → System; a source checkout uses <repo>/.data.",
    );
  }
  return resolve(dir);
}

function emitJson(args: ParsedArgs, payload: unknown): boolean {
  if (!has(args, "json")) return false;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

const RESTART_NOTE = "  Restart Dispatch to apply (plugins are read at boot; nothing is hot-reloaded).\n";

async function cmdAdd(args: ParsedArgs): Promise<void> {
  const [source] = args.positionals;
  if (!source) throw new CmError("Usage: cm plugin add <path | git-url | tarball> [--force]");
  const result = await addPlugin(configDirOf(args), source, { force: has(args, "force") });
  if (emitJson(args, result)) return;
  const m = result.plugin.manifest!;
  process.stdout.write(`${result.outcome === "replaced" ? "Replaced" : "Installed"} ${m.id} → ${result.dir}\n`);
  for (const line of consentLines(m)) process.stdout.write(`${line}\n`);
  process.stdout.write(RESTART_NOTE);
}

async function cmdLink(args: ParsedArgs): Promise<void> {
  const [source] = args.positionals;
  if (!source) throw new CmError("Usage: cm plugin link <path> [--force]");
  const result = await linkPlugin(configDirOf(args), source, { force: has(args, "force") });
  if (emitJson(args, result)) return;
  const m = result.plugin.manifest!;
  process.stdout.write(`Linked ${m.id} → ${result.dir}\n`);
  for (const line of consentLines(m)) process.stdout.write(`${line}\n`);
  process.stdout.write(RESTART_NOTE);
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const configDir = configDirOf(args);
  const [plugins, toggles] = await Promise.all([discoverPlugins(configDir), readPluginToggles(configDir)]);
  const rows = plugins.map((p) => ({ ...p, enabled: toggles[p.id] ?? true }));
  if (emitJson(args, { root: pluginsRoot(configDir), apiVersion: PLUGIN_API_VERSION, plugins: rows })) return;
  if (!rows.length) {
    process.stdout.write(`No plugins in ${pluginsRoot(configDir)}\n  Add one:  cm plugin add <path | git-url | tarball>\n`);
    return;
  }
  process.stdout.write(`${rows.length} plugin(s) in ${pluginsRoot(configDir)}:\n`);
  for (const p of rows) {
    const state = !p.manifest ? "invalid" : p.incompatible ? "incompatible" : p.enabled ? "enabled" : "disabled";
    const name = p.manifest ? `${p.manifest.name} v${p.manifest.version}` : "";
    process.stdout.write(`  ${p.id.padEnd(20)} ${state.padEnd(12)} ${name}${p.linked ? " (linked)" : ""}\n`);
    if (p.error) process.stdout.write(`${"".padEnd(23)}${p.error}\n`);
  }
}

async function cmdEnable(args: ParsedArgs, enabled: boolean): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError(`Usage: cm plugin ${enabled ? "enable" : "disable"} <id>`);
  const configDir = configDirOf(args);
  const known = (await discoverPlugins(configDir)).some((p) => p.id === id);
  if (!known) throw new CmError(`No plugin "${id}" in ${pluginsRoot(configDir)}.`);
  await setPluginEnabled(configDir, id, enabled);
  if (emitJson(args, { ok: true, id, enabled })) return;
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${id}\n`);
  // Both directions need a restart from here: the server reads the toggle map
  // once at boot and only its own PUT /api/plugins/:id/enabled changes it live.
  // Settings → Plugins is the way to turn one off without restarting.
  process.stdout.write(RESTART_NOTE);
}

async function cmdRemove(args: ParsedArgs): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError("Usage: cm plugin remove <id>");
  const { removed, dir } = await removePlugin(configDirOf(args), id);
  if (emitJson(args, { ok: removed, id, dir })) return;
  if (!removed) throw new CmError(`No plugin "${id}" to remove.`);
  process.stdout.write(`Removed ${id} (${dir})\n${RESTART_NOTE}`);
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError("Usage: cm plugin init <id> [--server | --client | --both] [--name <display name>] [--dir <parent>] [--sdk <path>]");
  const picked = (["server", "client", "both"] as const).filter((k) => has(args, k));
  if (picked.length > 1) throw new CmError("Pick one of --server, --client, --both.");
  const kind: PluginScaffoldKind = picked[0] ?? "both";
  const result = await initPlugin({
    id,
    kind,
    ...(flag(args, "name") ? { name: flag(args, "name") } : {}),
    ...(flag(args, "dir") ? { dir: resolve(flag(args, "dir")!) } : {}),
    ...(flag(args, "sdk") ? { sdkPath: resolve(flag(args, "sdk")!) } : {}),
  });
  if (emitJson(args, result)) return;
  const halves = kind === "both" ? "server + client" : kind;
  process.stdout.write(`Created ${id} at ${result.dir} (${halves}; SDK ${result.sdkLink})\n`);
  for (const f of result.files) process.stdout.write(`  ${f}\n`);
  process.stdout.write(
    [
      "",
      "Next:",
      `  cd ${result.dir}`,
      "  pnpm install",
      "  pnpm build          # src/ → the entries plugin.yaml names",
      ...(kind !== "client" ? ["  pnpm test           # activate() under @dispatch/plugin-sdk/testing"] : []),
      "  cm plugin add . --config-dir <dir>   # or: cm plugin link .   (development)",
      "  then restart Dispatch and look under Settings → Plugins.",
      "",
    ].join("\n"),
  );
}

export const PLUGIN_HELP = `cm plugin — install and manage Dispatch plugins (<configDir>/plugins/<id>/)

Usage:
  cm plugin init <id> [--server|--client|--both]   Scaffold a plugin against @dispatch/plugin-sdk (default: both)
                     [--name <n>] [--dir <parent>] [--sdk <path>]
  cm plugin add <path | git-url | tarball>   Copy a plugin in, validate it, print what it asks for
  cm plugin link <path>                      Junction/symlink a working directory (development)
  cm plugin list                             List installed plugins and their state
  cm plugin enable <id>                      Turn a plugin on (takes effect after a restart)
  cm plugin disable <id>                     Turn a plugin off
  cm plugin remove <id>                      Delete (or unlink) a plugin

Options:
      --config-dir <dir>   Dispatch's config root (default: $DISPATCH_CONFIG_DIR, then $DISPATCH_DATA_DIR)
  -f, --force              Replace a plugin that is already installed
      --json               Machine-readable output

Plugins are global: both the stable and the dev instance load the same
directory, and an upgrade never touches it. Changing a plugin needs a restart.
`;

/** Route a `cm plugin <sub> …` invocation. */
export async function runPluginCommand(argv: readonly string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(PLUGIN_HELP);
    return;
  }
  const args = parseArgs(rest);
  if (has(args, "help")) {
    process.stdout.write(PLUGIN_HELP);
    return;
  }
  switch (sub) {
    case "init":
    case "new":
    case "create":
      return cmdInit(args);
    case "add":
    case "install":
      return cmdAdd(args);
    case "link":
      return cmdLink(args);
    case "list":
    case "ls":
      return cmdList(args);
    case "enable":
      return cmdEnable(args, true);
    case "disable":
      return cmdEnable(args, false);
    case "remove":
    case "rm":
    case "uninstall":
      return cmdRemove(args);
    default:
      throw new CmError(`Unknown command "cm plugin ${sub}". Run \`cm plugin help\` for usage.`);
  }
}
