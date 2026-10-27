/**
 * A plugin COLLECTION — one repository (or one directory of it) holding
 * several plugins, each in its own subdirectory with its own `plugin.yaml`.
 *
 * Pasting a collection's URL lists every plugin in it to pick from, instead of
 * making the owner hunt down one `/tree/<ref>/<subdir>` link per plugin. Each
 * pick then installs exactly as a single plugin always has — same report, same
 * install path, same recorded source (the collection URL plus that plugin's
 * `subdir`) — so updates and uninstall need nothing collection-specific.
 *
 * A directory with its own `plugin.yaml` is always ONE plugin; a collection
 * is a directory without one. `dispatch-plugins.yaml` at its root is OPTIONAL. Without it every
 * directory holding a `plugin.yaml` is listed (outermost wins); with it, only
 * and exactly the paths it names, in its order. It deliberately carries no
 * per-plugin metadata: name, version and capabilities live in each
 * `plugin.yaml`, and a second copy here would drift from the one the host
 * actually reads.
 *
 * See docs/plugins.md → "Several plugins in one repository".
 */
import * as z from "zod";
import { PluginInspectionSchema, PluginInspectionSourceSchema, type PluginInspection } from "./plugin-inspection.js";

/** The collection manifest filename, at the collection root. */
export const PLUGIN_COLLECTION_FILE = "dispatch-plugins.yaml";

/** More than this and it is a monorepo being scanned by accident, not a collection anyone curated. */
export const MAX_COLLECTION_PLUGINS = 50;

export const PluginCollectionManifestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  plugins: z
    .array(z.union([z.string().min(1), z.object({ path: z.string().min(1) }).passthrough()]))
    .min(1, "list at least one plugin path")
    .max(MAX_COLLECTION_PLUGINS),
});
export type PluginCollectionManifest = z.infer<typeof PluginCollectionManifestSchema>;

/**
 * `s` without leading and trailing `/`. A loop, not `/^\/+|\/+$/`: these paths
 * come from a stranger's manifest, and that regex backtracks polynomially on a
 * long run of slashes (CodeQL js/polynomial-redos).
 */
export function trimSlashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 47) a++;
  while (b > a && s.charCodeAt(b - 1) === 47) b--;
  return s.slice(a, b);
}

/**
 * A manifest path → a clean relative path (`""` for the collection root), or
 * the reason it is refused. It names a directory inside a stranger's archive,
 * so nothing that could step outside the collection gets through.
 */
export function normaliseCollectionPath(raw: string): { path: string } | { error: string } {
  let s = raw.trim();
  while (s.startsWith("./")) s = s.slice(2);
  // An absolute path keeps its leading slash, so the check below names it.
  if (!s.startsWith("/")) s = trimSlashes(s);
  if (s === "" || s === ".") return { path: "" };
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return { error: `"${raw}" is absolute — paths are relative to the collection root` };
  if (s.includes("\\")) return { error: `"${raw}" uses a backslash — use / between directories` };
  const segs = s.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) return { error: `"${raw}" must not contain empty, . or .. segments` };
  return { path: segs.join("/") };
}

export interface CollectionListing {
  /** Plugin directories relative to the collection root, in display order. */
  members: string[];
  listedBy: "manifest" | "scan";
  name?: string;
  description?: string;
  /** Problems with `dispatch-plugins.yaml`; when it was unusable the listing fell back to a scan. */
  manifestErrors: string[];
}

/**
 * Which plugins a collection holds. `manifestText` is `dispatch-plugins.yaml`'s
 * raw parsed value (undefined when absent); `manifestDirs` are the directories,
 * relative to the collection root, where a `plugin.yaml` was seen.
 *
 * A broken manifest does not hide the collection — the owner pasted the URL
 * to install something — so it falls back to the scan and SAYS so.
 */
export function listCollection(manifest: unknown, manifestDirs: readonly string[]): CollectionListing {
  const errors: string[] = [];
  if (manifest !== undefined) {
    const parsed = PluginCollectionManifestSchema.safeParse(manifest);
    if (parsed.success) {
      const members: string[] = [];
      for (const entry of parsed.data.plugins) {
        const raw = typeof entry === "string" ? entry : entry.path;
        const n = normaliseCollectionPath(raw);
        if ("error" in n) errors.push(n.error);
        else if (!members.includes(n.path)) members.push(n.path);
      }
      if (members.length) {
        return {
          members,
          listedBy: "manifest",
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          manifestErrors: errors,
        };
      }
    } else {
      errors.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    }
    errors.push(`${PLUGIN_COLLECTION_FILE} is unusable — listing every plugin.yaml instead`);
  }
  // Outermost wins: a plugin that vendors an example plugin inside its own
  // tree is ONE plugin, not two — installing the inner one on its own is
  // almost never what the author meant.
  const sorted = [...new Set(manifestDirs)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const members: string[] = [];
  for (const dir of sorted) {
    if (members.some((m) => m === "" || dir === m || dir.startsWith(`${m}/`))) continue;
    members.push(dir);
  }
  members.sort((a, b) => a.localeCompare(b));
  return { members: members.slice(0, MAX_COLLECTION_PLUGINS), listedBy: "scan", manifestErrors: errors };
}

/** One row of a collection report: a full single-plugin report, or why there is none. */
export const PluginCollectionEntrySchema = z.object({
  /** Repository-relative directory — what Install posts as `subdir`. */
  subdir: z.string(),
  report: PluginInspectionSchema.optional(),
  error: z.string().optional(),
});
export type PluginCollectionEntry = z.infer<typeof PluginCollectionEntrySchema>;

/** What `POST /api/plugins/inspect` answers for a URL that holds several plugins. */
export const PluginCollectionInspectionSchema = z.object({
  kind: z.literal("collection"),
  /** `subdir` here is the collection root, not a plugin. */
  source: PluginInspectionSourceSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  listedBy: z.enum(["manifest", "scan"]),
  manifestErrors: z.array(z.string()),
  plugins: z.array(PluginCollectionEntrySchema),
});
export type PluginCollectionInspection = z.infer<typeof PluginCollectionInspectionSchema>;

/** Either answer `POST /api/plugins/inspect` can give. */
export type PluginInspectResult = PluginInspection | PluginCollectionInspection;

export function isPluginCollection(r: PluginInspectResult): r is PluginCollectionInspection {
  return (r as { kind?: string }).kind === "collection";
}
