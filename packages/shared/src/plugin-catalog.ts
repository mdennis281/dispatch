/**
 * Plugin CATALOGS — repositories Settings → Plugins lists plugins from, so
 * finding one is browsing rather than knowing a URL to paste.
 *
 * A catalog is nothing but a collection URL (plugin-collection.ts) the host
 * remembers and re-reads on a schedule. Installing from one is the ordinary
 * `POST /api/plugins/install {url, sha, subdir}` with the catalog's URL and
 * the member's subdir, so the recorded source, Check for updates, the
 * background watcher and uninstall all work exactly as for a pasted URL —
 * there is no "installed from a catalog" state to keep in step.
 *
 * Named "catalog" because both obvious words were taken: "provider" is an
 * agent runtime (Claude, Codex, goose — the `providers` capability), and
 * `PluginSource` is the per-install record of where ONE plugin came from.
 *
 * See docs/plugins.md → "Catalogs".
 */
import * as z from "zod";
import { PluginInspectionSchema } from "./plugin-inspection.js";

/** The catalog every install starts with. Listed always; can be switched off, never removed. */
export const BUILTIN_PLUGIN_CATALOG = {
  id: "dispatch",
  label: "Dispatch plugins",
  url: "https://github.com/mdennis281/dispatch-plugins",
} as const;

/** Enough for anyone's curation; past it the pane is a search problem this list does not solve. */
export const MAX_PLUGIN_CATALOGS = 20;

export const PLUGIN_CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A catalog the owner added. The built-in one is never stored — only whether it is switched off. */
export const PluginCatalogAddedSchema = z.object({
  id: z.string().regex(PLUGIN_CATALOG_ID_PATTERN),
  url: z.string().min(1).max(2048),
  label: z.string().max(80).optional(),
  /** Epoch ms. */
  addedAt: z.number(),
});
export type PluginCatalogAdded = z.infer<typeof PluginCatalogAddedSchema>;

/**
 * `AppSettings.pluginCatalogs`. In `config/` like `plugins` — both instances
 * install into the same `<configDir>/plugins/`, so they should browse the same
 * catalogs. Owned by `/api/plugin-catalogs/*`; the full-replace
 * `PUT /api/settings` preserves it by hand.
 */
export const PluginCatalogSettingsSchema = z.object({
  added: z.array(PluginCatalogAddedSchema).optional(),
  /** Ids switched off, the built-in one included. A disabled catalog is never fetched. */
  disabled: z.array(z.string()).optional(),
});
export type PluginCatalogSettings = z.infer<typeof PluginCatalogSettingsSchema>;

/**
 * One plugin a catalog lists, as the browse list needs it — the full report
 * stays on the server until the plugin is opened (`GET …/plugin?subdir=`), so
 * listing fifty plugins does not ship fifty READMEs and file scans.
 */
export const PluginCatalogMemberSchema = z.object({
  /** Repository-relative directory — what Install posts as `subdir`. */
  subdir: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  installable: z.boolean(),
  refusal: z.string().optional(),
  warnings: z.number().int().default(0),
  /** The same id under `<configDir>/plugins/` NOW — re-read on every list, not frozen at refresh. */
  installed: PluginInspectionSchema.shape.installed,
  /** No report at all: the member's directory could not be read. */
  error: z.string().optional(),
});
export type PluginCatalogMember = z.infer<typeof PluginCatalogMemberSchema>;

export const PluginCatalogSchema = z.object({
  id: z.string(),
  url: z.string(),
  label: z.string(),
  builtin: z.boolean(),
  enabled: z.boolean(),
  /** A refresh is running for it right now. */
  refreshing: z.boolean(),
  /** Epoch ms of the last refresh that SUCCEEDED; a failed one keeps the previous listing. */
  refreshedAt: z.number().optional(),
  /** Epoch ms of the last attempt, failed or not. */
  attemptedAt: z.number().optional(),
  /** Why the last refresh failed. The listing below is from `refreshedAt`. */
  error: z.string().optional(),
  /** From the catalog's `dispatch-plugins.yaml`, when it has one. */
  name: z.string().optional(),
  description: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  browseUrl: z.string().optional(),
  manifestErrors: z.array(z.string()).default([]),
  plugins: z.array(PluginCatalogMemberSchema),
});
export type PluginCatalog = z.infer<typeof PluginCatalogSchema>;

/** `GET /api/plugin-catalogs`. */
export const PluginCatalogsStatusSchema = z.object({
  /** The background refresh cadence — the same `DISPATCH_PLUGIN_UPDATE_HOURS` as update checks; 0 = off. */
  intervalHours: z.number(),
  nextRunAt: z.number().optional(),
  catalogs: z.array(PluginCatalogSchema),
});
export type PluginCatalogsStatus = z.infer<typeof PluginCatalogsStatusSchema>;

export const PluginCatalogAddRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  label: z.string().max(80).optional(),
});
export type PluginCatalogAddRequest = z.infer<typeof PluginCatalogAddRequestSchema>;

export const PluginCatalogEnabledRequestSchema = z.object({ enabled: z.boolean() });

/*
 * The URL helpers below are plain string work, not regexes: the input is a
 * pasted URL, and patterns like a trailing-run strip backtrack polynomially
 * on a crafted one (CodeQL js/polynomial-redos).
 */

/** `s` without any leading or trailing `ch`. */
function trimRuns(s: string, ch: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ch) a++;
  while (b > a && s[b - 1] === ch) b--;
  return s.slice(a, b);
}

function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** `owner/repo` of a URL, dropping scheme, host, a `/tree/…` or `/blob/…` tail and `.git`. */
function repoPathOf(url: string): string {
  let s = url.trim().toLowerCase();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  else if (s.startsWith("git@")) s = s.slice(s.indexOf(":") + 1);
  if (scheme >= 0) s = s.slice(s.indexOf("/") + 1);
  for (const marker of ["/tree/", "/blob/"]) {
    const at = s.indexOf(marker);
    if (at >= 0) s = s.slice(0, at);
  }
  return stripSuffix(trimRuns(s, "/"), ".git");
}

/** A catalog id from a URL: `github.com/acme/dispatch-extras` → `acme-dispatch-extras`, unique against `taken`. */
export function catalogIdFor(url: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = trimRuns(repoPathOf(url).replace(/[^a-z0-9]+/g, "-"), "-").slice(0, 32) || "catalog";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, 36)}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Same repository and directory, however it was written — what makes a second add of one URL a duplicate. */
export function sameCatalogUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    let s = u.trim().toLowerCase();
    if (s.startsWith("git@github.com:")) s = `https://github.com/${s.slice("git@github.com:".length)}`;
    let end = s.length;
    while (end > 0 && s[end - 1] === "/") end--;
    return stripSuffix(s.slice(0, end), ".git");
  };
  return norm(a) === norm(b);
}
