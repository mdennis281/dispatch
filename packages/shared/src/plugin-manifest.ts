/**
 * The plugin manifest — `plugin.yaml` at the root of `<configDir>/plugins/<id>/`.
 *
 * One schema, three consumers: the server's loader decides what to activate
 * from it, `cm plugin add` validates a candidate BEFORE copying it into place,
 * and the Settings pane renders the row from the server's parse of it. Keeping
 * the shape here (and not in the server) is what stops the CLI accepting a
 * manifest the loader would then list as `invalid` — the failure that
 * `project.yaml` had before its schema moved into this package.
 *
 * See docs/plugins.md → "Anatomy of a plugin".
 */
import * as z from "zod";
import { ManifestMcpServerSchema } from "./project-config.js";

/**
 * The host's plugin-API MAJOR. A manifest's `dispatch` range is matched against
 * this number alone: the API is additive within a major, so a plugin built
 * against `>=1` keeps working until something in {@link PluginContext} is
 * removed or changes meaning — and that is the only event that bumps this.
 */
export const PLUGIN_API_VERSION = 1;

/** The manifest filename inside a plugin directory. */
export const PLUGIN_MANIFEST_FILE = "plugin.yaml";

/** The directory under the config root that holds every plugin. */
export const PLUGINS_DIR_NAME = "plugins";

/**
 * Reserved id prefix. Dispatch's own MCP servers are `dispatch-*`, and a plugin
 * whose id collides with that namespace would be indistinguishable from the
 * host in a tool name, a settings key or a route prefix. Same rule, same
 * reason, as the MCP server-name chokepoint.
 */
export const RESERVED_PLUGIN_ID_PREFIX = "dispatch-";

/**
 * `[a-z0-9][a-z0-9-]{0,39}` — a path segment, a settings key, a route prefix and
 * a `plugin-event` discriminator all at once, so it is the strictest of the four.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const PluginIdSchema = z
  .string()
  .regex(PLUGIN_ID_PATTERN, "id must be 1–40 chars of [a-z0-9-], starting with a letter or digit")
  .refine((id) => !id.startsWith(RESERVED_PLUGIN_ID_PREFIX), {
    message: `ids starting with "${RESERVED_PLUGIN_ID_PREFIX}" are reserved for Dispatch`,
  });

/**
 * What a plugin declares it will touch. Each one gates a member of the server
 * context (see the table in docs/plugins.md → "Capabilities"); a capability not
 * declared is simply absent from the object `activate` receives. The list is
 * for the consent card and the Settings row — a declaration, not a sandbox.
 */
export const PLUGIN_CAPABILITIES = [
  "events",
  "routes",
  "chats:read",
  "chats:write",
  "memory",
  "secrets",
  "kv",
  "mcp",
  "process",
  "oauth",
  "ui",
] as const;
export const PluginCapabilitySchema = z.enum(PLUGIN_CAPABILITIES);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

/**
 * A relative path inside the plugin directory. Absolute paths and `..` are
 * refused here rather than at load time so the CLI's validation and the
 * server's agree: a manifest pointing outside its own directory is invalid,
 * not merely unloadable.
 */
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !/^([a-zA-Z]:)?[\\/]/.test(p), { message: "must be relative to the plugin directory" })
  .refine((p) => !p.split(/[\\/]/).includes(".."), { message: "must not leave the plugin directory" });

/** `[a-z0-9][a-z0-9-]{0,31}` — an `oauth.clients` key is a URL path segment of the callback and a column value, so it is kept this strict. */
export const PLUGIN_OAUTH_CLIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `oauth.clients.<name>` — parsed here so an invalid entry is an invalid
 * manifest. `clientId` / `clientSecret` may be literals or `${secret:NAME}`
 * references; a reference resolves ONLY when `NAME` is also listed under
 * `secrets:`, the same rule `ctx.secrets.get` follows, so a manifest cannot
 * reach a secret it never declared by routing it through the OAuth block.
 */
export const PluginOAuthClientSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()).optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  /**
   * Extra query parameters on the authorization URL — `access_type=offline`,
   * `prompt=consent`, an `audience`. Values are sent verbatim; the standard
   * parameters (`client_id`, `redirect_uri`, `state`, PKCE…) are the host's
   * and cannot be overridden from here.
   */
  extraParams: z.record(z.string(), z.string()).optional(),
});
export type PluginOAuthClient = z.infer<typeof PluginOAuthClientSchema>;

/** Normalised parent directory of a manifest path: `./client/index.js` → `client`, `index.js` → `` (the root). */
export function manifestPathDir(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter((s) => s && s !== ".");
  return parts.slice(0, -1).join("/");
}

const PluginManifestObjectSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1),
  /** The plugin's own version. Semver-shaped; not interpreted by the host. */
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version must be semver (x.y.z)"),
  /**
   * The host plugin-API major the plugin was built against, as a range over
   * {@link PLUGIN_API_VERSION}: `">=1"`, `"^1"`, `"1"`, `"1.x"`, `">=1 <3"`.
   * Required, because a manifest that says nothing about compatibility would
   * have to be guessed at — and guessing "compatible" is how a plugin built
   * against a retired context member crashes at activate instead of being
   * listed as incompatible.
   */
  dispatch: z.string().min(1),
  description: z.string().optional(),
  /** ESM module exporting `activate` / `deactivate`. Relative to the plugin dir. */
  server: RelativePathSchema.optional(),
  /** ESM module exporting `activate(host)`; served under `/plugins/<id>/` (workstream E). */
  client: RelativePathSchema.optional(),
  /** JSON Schema for `AppSettings.plugins[id].settings`, rendered as a generic form. */
  settings: RelativePathSchema.optional(),
  /** Secret names the plugin may read through `ctx.secrets`. Anything else is invisible to it. */
  secrets: z.array(z.string().min(1)).optional(),
  capabilities: z.array(PluginCapabilitySchema).optional(),
  /** Contribution roots — consumed by workstream D; validated here so the shape is settled. */
  contributes: z
    .object({
      modes: RelativePathSchema.optional(),
      skills: RelativePathSchema.optional(),
      instructions: RelativePathSchema.optional(),
      personas: RelativePathSchema.optional(),
      mcpServers: RelativePathSchema.optional(),
      processes: RelativePathSchema.optional(),
    })
    .optional(),
  oauth: z
    .object({
      clients: z.record(z.string().regex(PLUGIN_OAUTH_CLIENT_NAME_PATTERN), PluginOAuthClientSchema).optional(),
    })
    .optional(),
});

/**
 * The `client` directory is served to the browser WITHOUT authentication
 * (see docs/plugins.md → "Client host"), as a whole directory. So it must hold
 * nothing else of the plugin's: not the server module, which may embed a
 * token, and not the plugin root, which would publish the manifest, the
 * settings schema and every contribution. Enforced here so `cm plugin add`
 * refuses the layout before it is ever on disk.
 */
export const PluginManifestSchema = PluginManifestObjectSchema.superRefine((m, ctx) => {
  if (!m.client) return;
  const clientDir = manifestPathDir(m.client);
  if (clientDir === "") {
    ctx.addIssue({
      code: "custom",
      path: ["client"],
      message: "client must sit in its own directory (e.g. ./client/index.js), not at the plugin root — that directory is served publicly",
    });
    return;
  }
  const others: Array<[string, string | undefined]> = [
    ["server", m.server],
    ["settings", m.settings],
    ...Object.entries(m.contributes ?? {}),
  ];
  for (const [key, value] of others) {
    if (!value) continue;
    const dir = manifestPathDir(value);
    const sameOrInside = dir === clientDir || dir.startsWith(`${clientDir}/`) || value.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "") === clientDir;
    if (sameOrInside) {
      ctx.addIssue({
        code: "custom",
        path: ["client"],
        message: `client's directory "${clientDir}/" is served publicly and must not also hold "${key}" (${value})`,
      });
    }
  }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Does a manifest's `dispatch` range admit host API major `major`?
 *
 * A deliberately small grammar rather than a semver dependency: the only thing
 * compared is one integer, and the forms below are every way an author would
 * reasonably write "built against major N". Space-separated clauses AND
 * together; `||` is not supported (nothing here needs it). Unparseable input
 * is `false` — a range nobody can read admits nothing, which lists the plugin
 * as incompatible with its range in the error text rather than activating it
 * on a guess.
 */
export function pluginRangeAccepts(range: string, major: number): boolean {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) return false;
  for (const clause of clauses) {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(clause);
    if (!m) return false;
    const op = m[1] ?? "";
    const n = Number(m[2]);
    let ok: boolean;
    switch (op) {
      case ">=":
        ok = major >= n;
        break;
      case ">":
        ok = major > n;
        break;
      case "<=":
        ok = major <= n;
        break;
      case "<":
        ok = major < n;
        break;
      // `^1`, `~1`, `1`, `1.x`, `=1` all pin the major.
      default:
        ok = major === n;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

/* ------------------------------------------------------- contribution files */

/**
 * `contributes.mcpServers` — the file it points at (`mcp.yaml` by convention).
 *
 * The SAME per-server shape a project's `mcpServers:` list uses, so a server
 * definition can be moved between a project manifest and a plugin without
 * rewriting it. Two rules differ and are applied by the loader, not here:
 * the default `cwd` is the PLUGIN directory (a project server's default is
 * the chat's tree, which is wrong for code that ships with the plugin), and
 * `${secret:NAME}` expands only for names the manifest lists under `secrets:`.
 * Accepts either a bare list or `{ mcpServers: [...] }`, the latter so a file
 * copied from a project manifest works unchanged.
 */
export const PluginMcpServersFileSchema = z.union([
  z.array(ManifestMcpServerSchema),
  z.object({ mcpServers: z.array(ManifestMcpServerSchema).default([]) }).transform((o) => o.mcpServers),
]);

/** `[a-z0-9][a-z0-9-]*` — a process id is a runner `subAppId` and a port-lease key. */
export const PLUGIN_PROCESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * One entry of `contributes.processes` — a long-running process the host runs
 * through `RunnerService` on the plugin's behalf, with owner `plugin:<id>`.
 *
 * Modelled on a sub-app's `dev` rather than on a raw spawn: `command` + `args`
 * are joined VERBATIM into ONE shell line (the runner spawns through a shell,
 * which is what makes `pnpm`/`npx` shims work on Windows) — write an argument
 * with spaces quoted, as you would at the prompt. `{port}`/`{portN}` in any of
 * them are substituted from the leased ports, and `env` is overlaid on the
 * manager-quarantined environment exactly as for a sub-app.
 */
export const PluginProcessSchema = z
  .object({
    id: z.string().regex(PLUGIN_PROCESS_ID_PATTERN, "process id must be 1–40 chars of [a-z0-9-]"),
    /** Display name; defaults to the id. */
    name: z.string().min(1).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory, relative to the plugin dir. Defaults to the plugin dir. */
    cwd: z.string().optional(),
    /** Base ports to lease; the first is injected as `PORT` and fills `{port}`. */
    ports: z.array(z.number().int().min(1).max(65535)).max(8).optional(),
    /** One-click URL template, e.g. `http://localhost:{port}`. */
    url: z.string().optional(),
    /** Start on plugin activation (default false — `ctx.processes.start` otherwise). */
    autostart: z.boolean().optional(),
    /**
     * Only one may run per machine. Both Dispatch instances load the same
     * plugin, so the second to activate ADOPTS a process already listening on
     * the first declared port instead of spawning another. Requires `ports`,
     * because the port is the only identity two processes can see of each other.
     */
    singleton: z.boolean().optional(),
  })
  .refine((p) => !p.singleton || (p.ports?.length ?? 0) > 0, {
    message: "a singleton process must declare at least one port — that is how the second instance finds it",
    path: ["singleton"],
  });
export type PluginProcess = z.infer<typeof PluginProcessSchema>;

/** `contributes.processes` — the file (`processes.yaml`): a bare list or `{ processes: [...] }`. */
export const PluginProcessesFileSchema = z.union([
  z.array(PluginProcessSchema),
  z.object({ processes: z.array(PluginProcessSchema).default([]) }).transform((o) => o.processes),
]);

/* ------------------------------------------------------------ API rows */

/**
 * Where a plugin stands, as `GET /api/plugins` reports it.
 *
 *   active        — its server module activated (or it has none to activate)
 *   disabled      — valid, but `AppSettings.plugins[id].enabled` is false
 *   error         — `activate` threw or ran past its budget; see `error`
 *   invalid       — the manifest failed validation; see `error`
 *   incompatible  — its `dispatch` range excludes this host's API major
 */
export const PluginStatusSchema = z.enum(["active", "disabled", "error", "invalid", "incompatible"]);
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

/**
 * One row of `GET /api/plugins`. A summary of the manifest plus the host's
 * verdict on it — never the raw manifest, which may be the thing that failed
 * to parse.
 */
export const PluginInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  /** Absolute path of the plugin directory — what "open folder" opens. */
  dir: z.string(),
  status: PluginStatusSchema,
  /** The message behind an `error` / `invalid` / `incompatible` status. */
  error: z.string().optional(),
  /** The stored toggle (default true). Distinct from `status`: an enabled plugin may be `error`. */
  enabled: z.boolean(),
  /**
   * The toggle was flipped on in this process and the plugin has not been
   * activated — hot reload is out of scope, so the pane says "restart to apply".
   */
  needsRestart: z.boolean().optional(),
  capabilities: z.array(PluginCapabilitySchema),
  hasServer: z.boolean(),
  /** Where the client half is served, when the manifest has one (workstream E). */
  clientUrl: z.string().optional(),
  /** The parsed `settings` JSON Schema, when the manifest names one. */
  settingsSchema: z.unknown().optional(),
  /** The stored `AppSettings.plugins[id].settings`, or `{}`. */
  settings: z.record(z.string(), z.unknown()),
  /** Secret names the manifest lists — the pane shows which are set. */
  secrets: z.array(z.string()).optional(),
  /**
   * The manifest's `oauth.clients`, each with its connection state — what the
   * pane's Connect / Disconnect row reads. Present only when the manifest
   * declares the `oauth` capability AND at least one client.
   */
  oauth: z
    .array(
      z.object({
        name: z.string(),
        connected: z.boolean(),
        expiresAt: z.number().optional(),
        scopes: z.array(z.string()).optional(),
        configError: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Non-fatal problems with the plugin's CONTRIBUTIONS — an `mcp.yaml` that
   * failed to parse, a server named `dispatch-*`, a process declared without
   * the `process` capability. The plugin still activates (its code is fine);
   * the offending contribution is dropped and named here, because the only
   * other place it shows is a server log nobody reads.
   */
  warnings: z.array(z.string()).optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

/** `AppSettings.plugins[id]` — the only per-plugin state the host keeps in config. */
export const PluginSettingsEntrySchema = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type PluginSettingsEntry = z.infer<typeof PluginSettingsEntrySchema>;
