/**
 * `dispatch plugin …` — install and manage plugins under `<configDir>/plugins/`.
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
import { PLUGIN_API_VERSION, resolvePluginDependencies } from "@dispatch/shared";
import type { PluginChange } from "@dispatch/shared";
import {
  addPlugin,
  consentLines,
  discoverPlugins,
  linkPlugin,
  listCollectionMembers,
  pluginsRoot,
  readPluginToggles,
  removePlugin,
  setPluginEnabled,
  setPluginSource,
  type CollectionMember,
} from "../core/plugins.js";
import { checkPluginUpdates, purgePluginData, updatePlugins, type CliUpdateCheck } from "../core/plugin-lifecycle.js";
import {
  dependencyCheck,
  dependentsOf,
  installedDependencyNodes,
  memberNamed,
  parseWithDeps,
  planCollectionAdd,
  stillLacking,
} from "../core/plugin-deps.js";
import { initPlugin, type PluginScaffoldKind } from "../core/plugin-init.js";
import { CmError } from "../core/manifest.js";
import { all, flag, has, parseArgs, type ParsedArgs } from "../core/args.js";

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
  if (!source) {
    throw new CmError(
      "Usage: dispatch plugin add <path | git-url | tarball> [--plugin <path|id>]... [--all] [--with-deps[=all]] [--force] [--allow-breaking]",
    );
  }
  const configDir = configDirOf(args);
  const withDeps = parseWithDeps(flag(args, "with-deps"));
  const named = all(args, "plugin");
  // A collection: planned as a whole first — what each pick needs from the
  // same collection, provider first — then each pick is its own add, with
  // its own copy, validation and recorded source, so one bad member cannot
  // half-install the others.
  let picks: Array<{ plugin?: string; member?: CollectionMember }> = [{}];
  const failed: Array<{ plugin: string; error: string }> = [];
  let notes: string[] = [];
  let adding = new Set<string>();
  if (has(args, "all") || named.length) {
    const members = await listCollectionMembers(source);
    const wanted = has(args, "all") ? members.map((m) => ({ plugin: m.path, member: m })) : named.map((n) => ({ plugin: n, member: memberNamed(members, n) }));
    const plan = planCollectionAdd(
      members,
      wanted.flatMap((w) => (w.member ? [w.member] : [])),
      await installedDependencyNodes(configDir),
      withDeps,
    );
    // A name that matches no member stays in: `addPlugin` refuses it with the member list.
    picks = [...plan.add.map((m) => ({ plugin: m.path, member: m })), ...wanted.filter((w) => !w.member)];
    failed.push(...plan.refused.map((r) => ({ plugin: r.member.id ?? r.member.path, error: r.reason })));
    notes = plan.notes;
    adding = new Set(plan.add.flatMap((m) => (m.id ? [m.id] : [])));
    if (!picks.length && !failed.length) throw new CmError(`no plugins found in ${source}`);
  }
  const total = picks.length + failed.length;
  if (total === 1 && failed.length) throw new CmError(failed[0]!.error);
  const check = dependencyCheck(configDir, { allowBreaking: has(args, "allow-breaking"), alsoAdding: adding });
  const notInstalled = new Set(failed.map((f) => f.plugin));
  const results = [];
  for (const { plugin, member } of picks) {
    // A provider that failed above takes what needs it down with it, unless
    // what is installed still serves it — never a dependent left blocked
    // behind an error the owner may have scrolled past.
    const lacking = member?.manifest ? await stillLacking(configDir, member.manifest, notInstalled) : undefined;
    if (lacking) {
      failed.push({ plugin: member!.id ?? plugin!, error: `skipped: needs ${lacking}, which was not installed` });
      notInstalled.add(member!.id ?? plugin!);
      continue;
    }
    try {
      const result = await addPlugin(configDir, source, { force: has(args, "force"), check, ...(plugin !== undefined ? { plugin } : {}) });
      // Where it came from, in host-owned config — what `update` follows later.
      if (result.source) await setPluginSource(configDir, result.plugin.manifest!.id, result.source);
      results.push(result);
    } catch (err) {
      // One pick, one refusal: a single add keeps its exact error, but in a
      // batch the ones already on disk must still be reported, or `--plugin a
      // --plugin broken` leaves `a` installed with nothing having said so.
      if (total === 1 || !(err instanceof CmError)) throw err;
      failed.push({ plugin: member?.id ?? plugin!, error: err.message });
      notInstalled.add(member?.id ?? plugin!);
    }
  }
  const failure = failed.length
    ? new CmError(`${failed.length} of ${total} not installed:\n${failed.map((f) => `  ${f.plugin}: ${f.error}`).join("\n")}`)
    : undefined;
  if (emitJson(args, total === 1 ? { ...results[0], ...(notes.length ? { notes } : {}) } : { installed: results, failed, notes })) {
    if (failure) process.exitCode = 1;
    return;
  }
  for (const result of results) {
    const m = result.plugin.manifest!;
    process.stdout.write(`${result.outcome === "replaced" ? "Replaced" : "Installed"} ${m.id} → ${result.dir}\n`);
    for (const line of consentLines(m)) process.stdout.write(`${line}\n`);
    for (const w of result.warnings ?? []) process.stdout.write(`  warning: ${w}\n`);
  }
  for (const n of notes) process.stdout.write(`Note: ${n}\n`);
  if (results.length) process.stdout.write(RESTART_NOTE);
  if (failure) throw failure;
}

async function cmdLink(args: ParsedArgs): Promise<void> {
  const [source] = args.positionals;
  if (!source) throw new CmError("Usage: dispatch plugin link <path> [--force]");
  const configDir = configDirOf(args);
  const result = await linkPlugin(configDir, source, { force: has(args, "force") });
  // A link is its own origin; a source recorded for a copy it replaced would lie.
  await setPluginSource(configDir, result.plugin.manifest!.id, undefined);
  if (emitJson(args, result)) return;
  const m = result.plugin.manifest!;
  process.stdout.write(`Linked ${m.id} → ${result.dir}\n`);
  for (const line of consentLines(m)) process.stdout.write(`${line}\n`);
  process.stdout.write(RESTART_NOTE);
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const configDir = configDirOf(args);
  const [plugins, toggles, nodes] = await Promise.all([
    discoverPlugins(configDir),
    readPluginToggles(configDir),
    installedDependencyNodes(configDir),
  ]);
  // What the next boot would block, by the resolver the server runs.
  const resolved = resolvePluginDependencies(nodes);
  const rows = plugins.map((p) => {
    const blocked = resolved.blocked.get(p.id);
    return { ...p, enabled: toggles[p.id] ?? true, ...(blocked ? { blocked } : {}) };
  });
  if (emitJson(args, { root: pluginsRoot(configDir), apiVersion: PLUGIN_API_VERSION, plugins: rows })) return;
  if (!rows.length) {
    process.stdout.write(`No plugins in ${pluginsRoot(configDir)}\n  Add one:  dispatch plugin add <path | git-url | tarball>\n`);
    return;
  }
  process.stdout.write(`${rows.length} plugin(s) in ${pluginsRoot(configDir)}:\n`);
  for (const p of rows) {
    const state = !p.manifest ? "invalid" : p.incompatible ? "incompatible" : !p.enabled ? "disabled" : p.blocked ? "blocked" : "enabled";
    const name = p.manifest ? `${p.manifest.name} v${p.manifest.version}` : "";
    process.stdout.write(`  ${p.id.padEnd(20)} ${state.padEnd(12)} ${name}${p.linked ? " (linked)" : ""}\n`);
    if (p.error) process.stdout.write(`${"".padEnd(23)}${p.error}\n`);
    if (p.enabled && p.blocked) process.stdout.write(`${"".padEnd(23)}${p.blocked}\n`);
  }
  if (rows.some((p) => p.enabled && p.blocked?.includes("is not installed"))) {
    process.stdout.write("  (The CLI cannot see built-in plugins: one this depends on reads as not installed here.)\n");
  }
}

async function cmdEnable(args: ParsedArgs, enabled: boolean): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError(`Usage: dispatch plugin ${enabled ? "enable" : "disable"} <id>`);
  const configDir = configDirOf(args);
  const known = (await discoverPlugins(configDir)).some((p) => p.id === id);
  if (!known) throw new CmError(`No plugin "${id}" in ${pluginsRoot(configDir)}.`);
  await setPluginEnabled(configDir, id, enabled);
  // Switching a provider off is allowed — it is how the owner stops it — but
  // never silently: what needs it stops with it, and what can use it runs
  // with less.
  const affected = enabled ? { required: [], optional: [] } : dependentsOf(await installedDependencyNodes(configDir), id);
  if (emitJson(args, { ok: true, id, enabled, ...(enabled ? {} : { stops: affected.required, degrades: affected.optional }) })) return;
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${id}\n`);
  if (affected.required.length) process.stdout.write(`  Also stops (they need it): ${affected.required.join(", ")}\n`);
  if (affected.optional.length) process.stdout.write(`  Runs with less (they can use it): ${affected.optional.join(", ")}\n`);
  // Both directions need a restart from here: the server reads the toggle map
  // once at boot and only its own PUT /api/plugins/:id/enabled changes it live.
  // Settings → Plugins is the way to turn one off without restarting.
  process.stdout.write(RESTART_NOTE);
}

async function cmdRemove(args: ParsedArgs): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError("Usage: dispatch plugin remove <id> [--purge] [--data-dir <dir>] [--force]");
  const configDir = configDirOf(args);
  // Read before the directory goes: the manifest is what names its secrets.
  const found = (await discoverPlugins(configDir)).find((p) => p.id === id);
  // Refused while anything installed uses it, as the app refuses: removing
  // the dependents for the owner would run THEIR uninstall hooks — which may
  // destroy what they made — so it is never done implicitly.
  const affected = found ? dependentsOf(await installedDependencyNodes(configDir), id) : { required: [], optional: [] };
  const usedBy = [...affected.required, ...affected.optional];
  if (usedBy.length && !has(args, "force")) {
    throw new CmError(
      `${id} is used by ${usedBy.join(", ")} — remove ${usedBy.length === 1 ? "it" : "them"} first, or re-run with --force ` +
        `(${[
          affected.required.length ? `${affected.required.join(", ")} will be blocked` : "",
          affected.optional.length ? `${affected.optional.join(", ")} will run with less` : "",
        ]
          .filter(Boolean)
          .join("; ")})`,
    );
  }
  const { removed, dir } = await removePlugin(configDir, id);
  if (!removed) {
    if (emitJson(args, { ok: false, id, dir })) return;
    throw new CmError(`No plugin "${id}" to remove.`);
  }
  await setPluginSource(configDir, id, undefined);
  const purge = has(args, "purge")
    ? await purgePluginData(configDir, id, {
        manifestSecrets: found?.manifest?.secrets ?? [],
        dataDir: flag(args, "data-dir") ?? process.env.DISPATCH_DATA_DIR ?? process.env.CM_DATA_DIR,
      })
    : undefined;
  if (emitJson(args, { ok: true, id, dir, linked: !!found?.linked, ...(purge ? { purged: purge } : {}), ...(usedBy.length ? { stops: affected.required, degrades: affected.optional } : {}) })) return;
  process.stdout.write(`${found?.linked ? "Unlinked" : "Removed"} ${id} (${dir})${found?.linked ? " — the linked directory is untouched" : ""}\n`);
  if (affected.required.length) process.stdout.write(`  Now blocked (they need it): ${affected.required.join(", ")}\n`);
  if (affected.optional.length) process.stdout.write(`  Running with less (they could use it): ${affected.optional.join(", ")}\n`);
  if (purge) {
    const parts = [
      purge.settings ? "its settings entry" : "",
      purge.secrets.length ? `secrets ${purge.secrets.join(", ")}` : "",
      purge.kvKeys ? `${purge.kvKeys} kv key(s)` : "",
      purge.sharedKeys ? `${purge.sharedKeys} shared key(s) (every instance)` : "",
      purge.oauth?.length ? `OAuth tokens for ${purge.oauth.join(", ")}` : "",
    ].filter(Boolean);
    process.stdout.write(`  Purged: ${parts.length ? parts.join("; ") : "nothing was stored"}\n`);
    if (purge.sharedSecrets.length) {
      process.stdout.write(`  Kept (another plugin lists them): ${purge.sharedSecrets.join(", ")}\n`);
    }
    if (purge.stateSkipped) process.stdout.write(`  Not purged: ${purge.stateSkipped}\n`);
  } else {
    process.stdout.write("  Its settings, kv, secrets and OAuth tokens are kept — --purge removes them.\n");
  }
  process.stdout.write(RESTART_NOTE);
}

function changeLine(c: PluginChange): string {
  const sign = c.change === "added" ? "+" : c.change === "removed" ? "-" : "~";
  return `    ${sign} ${c.label}${c.detail ? ` — ${c.detail}` : ""}\n`;
}

function writeCheck(c: CliUpdateCheck & { updated?: boolean }): void {
  const cur = c.current ? `${c.current.version ? `v${c.current.version} ` : ""}${c.current.ref}@${c.current.sha.slice(0, 7)}` : "";
  const tgt = c.target ? `${c.target.version ? `v${c.target.version} ` : ""}${c.target.ref}@${c.target.sha.slice(0, 7)}` : "";
  const state =
    c.status === "available" ? (c.updated ? `updated ${cur} → ${tgt}` : `update available ${cur} → ${tgt}`) : c.status;
  process.stdout.write(`  ${c.id.padEnd(20)} ${state}${c.message ? ` — ${c.message}` : ""}\n`);
  if (!c.diff) return;
  if (c.diff.escalations.length) {
    process.stdout.write("    Asks for more:\n");
    for (const e of c.diff.escalations) process.stdout.write(changeLine(e));
  }
  if (c.diff.changes.length) {
    process.stdout.write("    Other changes:\n");
    for (const e of c.diff.changes) process.stdout.write(changeLine(e));
  }
}

async function cmdUpdate(args: ParsedArgs): Promise<void> {
  const [id] = args.positionals;
  const configDir = configDirOf(args);
  const results = has(args, "check")
    ? await checkPluginUpdates(configDir, { ...(id ? { id } : {}) })
    : await updatePlugins(configDir, { ...(id ? { id } : {}), acceptEscalations: has(args, "yes"), allowBreaking: has(args, "allow-breaking") });
  if (emitJson(args, results)) return;
  if (!results.length) {
    process.stdout.write(`No plugins in ${pluginsRoot(configDir)}\n`);
    return;
  }
  for (const r of results) writeCheck(r);
  if (results.some((r) => "updated" in r && r.updated)) process.stdout.write(RESTART_NOTE);
  else if (!has(args, "check") && results.some((r) => r.status === "available")) {
    process.stdout.write("  Nothing installed. Review the changes above, then re-run with --yes.\n");
  }
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const [id] = args.positionals;
  if (!id) throw new CmError("Usage: dispatch plugin init <id> [--server | --client | --both] [--name <display name>] [--dir <parent>] [--sdk <path>]");
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
      "  dispatch plugin add . --config-dir <dir>   # or: dispatch plugin link .   (development)",
      "  then restart Dispatch and look under Settings → Plugins.",
      "",
    ].join("\n"),
  );
}

export const PLUGIN_HELP = `dispatch plugin — install and manage Dispatch plugins (<configDir>/plugins/<id>/)

Usage:
  dispatch plugin init <id> [--server|--client|--both]   Scaffold a plugin against @dispatch/plugin-sdk (default: both)
                     [--name <n>] [--dir <parent>] [--sdk <path>]
  dispatch plugin add <path | git-url | tarball>   Copy a plugin in, validate it, print what it asks for
                     [--plugin <path|id>]... [--all]   …or pick from a collection (several plugins in one repo)
                     [--with-deps[=all]]               …and what the picks need from the same collection
  dispatch plugin link <path>                      Junction/symlink a working directory (development)
  dispatch plugin list                             List installed plugins and their state
  dispatch plugin enable <id>                      Turn a plugin on (takes effect after a restart)
  dispatch plugin disable <id>                     Turn a plugin off
  dispatch plugin update [<id>] [--check] [--yes]  Check git-installed plugins for a newer commit / tag, and install it
  dispatch plugin remove <id> [--purge]            Delete (or unlink) a plugin; --purge also deletes its data
                                                   (refused while another plugin uses it, unless --force)

Options:
      --config-dir <dir>   Dispatch's config root (default: $DISPATCH_CONFIG_DIR, then $DISPATCH_DATA_DIR)
  -f, --force              add: replace a plugin that is already installed
                           remove: remove one that other plugins use (they are blocked, or run with less)
      --plugin <path|id>   add: one plugin of a collection, by its path in it or its id (repeatable)
      --all                add: every plugin the collection lists
      --with-deps[=all]    add: also add what the picks require from the same collection, provider
                           first (=all: what they can optionally use, too)
      --allow-breaking     add, update: replace a plugin even though an installed plugin that uses
                           it would stop working (it drops an API major, or leaves a version range)
      --check              update: report what would change, install nothing
      --yes                update: install even when the new version asks for more
                           (capabilities, secrets, OAuth clients, MCP servers, processes)
      --purge              remove: also delete its settings entry, the secrets only it lists,
                           and — with --data-dir — that instance's kv rows and OAuth tokens
      --data-dir <dir>     The instance whose kv / OAuth tokens --purge clears (default: $DISPATCH_DATA_DIR)
      --json               Machine-readable output

Plugins are global: both the stable and the dev instance load the same
directory, and an upgrade never touches it. Changing a plugin needs a restart.
`;

/** Route a `dispatch plugin <sub> …` invocation. */
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
    case "update":
    case "upgrade":
      return cmdUpdate(args);
    default:
      throw new CmError(`Unknown command "dispatch plugin ${sub}". Run \`dispatch plugin help\` for usage.`);
  }
}
