/**
 * The report `POST /api/plugins/inspect` returns: what a plugin at a git URL
 * IS and what it HOOKS INTO, read without executing any of it.
 *
 * Deterministic on purpose — manifest, README and a static scan of the
 * source, no model in the loop — so the same sha always produces the same
 * report, and the report never claims more than the files say. The scan half
 * (`hooks`) is a token scan, not an evaluation: a plugin that reaches `ctx`
 * through an alias the scanner does not follow, or builds a member name at
 * runtime, can hide from it. The card says so; `scan.note` carries the words.
 *
 * See docs/plugins.md → "Inspecting a plugin before installing it".
 */
import * as z from "zod";
import { PluginCapabilitySchema, PluginStatusSchema } from "./plugin-manifest.js";

/**
 * One plain-language line per capability — what declaring it LETS the plugin
 * do, worded for the human deciding whether to install it. Shared so the
 * server's report and any other consent surface say the same sentence.
 */
export const PLUGIN_CAPABILITY_LINES: Record<z.infer<typeof PluginCapabilitySchema>, string> = {
  events: "Sees every event the server publishes — chat status, messages, attention items.",
  routes: "Serves its own HTTP endpoints under /api/plugins/<id>/.",
  "chats:read": "Lists, searches and reads your chats' transcripts.",
  "chats:write": "Sends messages and questions into your chats, and answers question cards.",
  memory: "Reads and writes projects' durable memory.",
  secrets: "Reads the secret values it lists under secrets: from the global store.",
  kv: "Keeps its own key/value data in this instance's database.",
  mcp: "Adds MCP servers (tools) to your agents' sessions.",
  process: "Starts and stops long-running processes on this machine.",
  oauth: "Connects to outside services with OAuth and holds their tokens.",
  ui: "Runs code in your browser: controls, panels, settings pages, badges.",
  providers: "Adds an agent runtime your chats can run on, and runs that runtime's CLI on this machine.",
  terminals:
    "Runs your chats' managed terminals somewhere else (a container, another machine) and sees every command and its output there.",
};

/** Where the inspected files came from, and exactly which commit. */
export const PluginInspectionSourceSchema = z.object({
  /** The URL as the owner pasted it. */
  url: z.string(),
  /** `github` — fetched as GitHub's tarball of the commit; `git` — any other https git host, fetched with git. */
  host: z.enum(["github", "git"]),
  /** `owner/repo` on GitHub; `host/path` elsewhere. */
  repo: z.string(),
  /** The clone URL install fetches from (normalised; never the pasted string). */
  cloneUrl: z.string(),
  /** The ref the URL named (`main`, `v1.2.0`), or the remote's default branch when it named none. */
  ref: z.string(),
  /** The full 40-hex commit sha that was inspected — what Install pins to. */
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** Directory inside the repository holding `plugin.yaml`; `""` for the root. */
  subdir: z.string(),
  /** A browsable link to that directory AT that sha, when the host has one. */
  browseUrl: z.string().optional(),
});
export type PluginInspectionSource = z.infer<typeof PluginInspectionSourceSchema>;

/** One thing the static scan found the code doing. */
export const PluginHookSchema = z.object({
  /**
   * event   — a bus / client event subscription
   * route   — an HTTP route the server half registers
   * slot    — a client slot (composerControl, settingsSection, panelTab, chatBadge, toast)
   * engine  — a dictation / TTS engine
   * chat    — per-chat state or actions from the browser (`chat.ext`, `chat.send`, `chat.setMode`)
   * api     — a host API call (`ctx.chats.send`, `ctx.kv.set`, …)
   * io      — reaches outside Dispatch: network, child processes, the filesystem, dynamic code
   */
  kind: z.enum(["event", "route", "slot", "engine", "chat", "api", "io"]),
  /** What it is, as it reads in source: `bus.on("chat-status")`, `GET /status`, `fetch(https://…)`. */
  label: z.string(),
  /** The capability this use requires, when one gates it. */
  capability: PluginCapabilitySchema.optional(),
  /** First place it was seen: path relative to the plugin dir, 1-based line. */
  file: z.string(),
  line: z.number().int(),
  /** How many times it appears across the scanned files. */
  count: z.number().int(),
});
export type PluginHook = z.infer<typeof PluginHookSchema>;

export const PluginInspectionMcpServerSchema = z.object({
  name: z.string(),
  transport: z.string(),
  /** stdio: the command and args AS DECLARED — `${…}` placeholders are left unexpanded. */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** http / sse: the URL as declared. */
  url: z.string().optional(),
  /** Names of env vars / headers it sets (values are not shown). */
  env: z.array(z.string()).optional(),
});

export const PluginInspectionProcessSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  ports: z.array(z.number()).optional(),
  url: z.string().optional(),
  autostart: z.boolean(),
  singleton: z.boolean(),
});

export const PluginInspectionSchema = z.object({
  source: PluginInspectionSourceSchema,
  /** Bounded fetch bookkeeping, so the card can say what it did NOT read. */
  fetched: z.object({
    files: z.number().int(),
    bytes: z.number().int(),
    /** Entries the extractor refused to write: symlinks, hard links, devices, unsafe names. */
    skipped: z.array(z.string()),
  }),
  /** `plugin.yaml` parsed AND passed `PluginManifestSchema`. */
  valid: z.boolean(),
  /** The manifest's validation errors, `path: message`, exactly as the host's loader would report them. */
  errors: z.array(z.string()),
  /** May the install route take this sha? False when invalid or incompatible; `refusal` says why. */
  installable: z.boolean(),
  refusal: z.string().optional(),

  /** Identity — best-effort even from an invalid manifest, so the card can still say what it is looking at. */
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  readme: z
    .object({
      file: z.string(),
      /** The first prose of the README (markdown), capped. */
      excerpt: z.string(),
    })
    .optional(),

  compatibility: z.object({
    /** The manifest's `dispatch` range, verbatim. */
    range: z.string().optional(),
    /** This host's `PLUGIN_API_VERSION`. */
    hostApi: z.number().int(),
    compatible: z.boolean(),
  }),

  /** What runs, and whether the entry file is actually in the tree (built output is often gitignored). */
  entries: z.object({
    server: z.object({ path: z.string(), present: z.boolean() }).optional(),
    client: z.object({ path: z.string(), present: z.boolean() }).optional(),
  }),

  capabilities: z.array(
    z.object({
      name: PluginCapabilitySchema,
      line: z.string(),
      /** Did the scan find a use? `null` when there was no code to scan for it. */
      used: z.boolean().nullable(),
    }),
  ),

  contributions: z.object({
    modes: z.array(z.string()),
    skills: z.array(z.string()),
    instructions: z.array(z.string()),
    personas: z.array(z.string()),
    mcpServers: z.array(PluginInspectionMcpServerSchema),
    processes: z.array(PluginInspectionProcessSchema),
  }),

  secrets: z.array(z.string()),
  oauth: z.array(
    z.object({
      name: z.string(),
      /** Host of the authorization URL — who the owner would be signing in to. */
      provider: z.string(),
      scopes: z.array(z.string()),
    }),
  ),
  /** The `settings` JSON Schema, parsed; the client renders its fields with the same reader the settings form uses. */
  settingsSchema: z.unknown().optional(),

  scan: z.object({
    /** Files the static scan read, relative to the plugin dir. */
    files: z.array(z.string()),
    /** Why the scan may be incomplete — always present; it is a token scan. */
    note: z.string(),
  }),
  hooks: z.array(PluginHookSchema),

  mismatches: z.object({
    /** Used in code (or by a contribution) but not declared — would be `undefined` at runtime, or ignored. */
    undeclared: z.array(z.object({ capability: PluginCapabilitySchema, because: z.array(z.string()) })),
    /** Declared but nothing found using it. */
    unused: z.array(PluginCapabilitySchema),
  }),
  /** Everything else worth reading before Install, most important first. */
  warnings: z.array(z.string()),

  /** The same id already under `<configDir>/plugins/`, and how its version compares. */
  installed: z
    .object({
      version: z.string().optional(),
      status: PluginStatusSchema.optional(),
      needsRestart: z.boolean().optional(),
      /** The inspected version against the installed one. */
      comparison: z.enum(["same", "newer", "older", "unknown"]),
      /** It is a `dispatch plugin link` junction — Install would replace the link with a copy. */
      linked: z.boolean().optional(),
    })
    .optional(),
});
export type PluginInspection = z.infer<typeof PluginInspectionSchema>;

export const PluginInspectRequestSchema = z.object({ url: z.string().min(1).max(2048) });
export const PluginInstallRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  /** The commit the owner was shown. Install fetches THIS, not whatever the ref points at now. */
  sha: z.string().regex(/^[0-9a-f]{40}$/, "sha must be a full 40-character commit hash"),
});

/** What `POST /api/plugins/install` answers. */
export const PluginInstallResultSchema = z.object({
  id: z.string(),
  outcome: z.enum(["copied", "replaced"]),
  sha: z.string(),
  /** Always true: plugins are not hot-loaded. */
  needsRestart: z.literal(true),
});
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>;
