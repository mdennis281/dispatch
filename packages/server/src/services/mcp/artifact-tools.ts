/**
 * The `dispatch-artifacts` tools — publish a rendered page, SVG, document or
 * code listing into a pane beside the chat. Storage lives in
 * services/artifacts.ts; this is only the tool surface, kept out of
 * manager-mcp.ts like chat-tree-tool.ts and attention-tools.ts.
 *
 * Every successful result ENDS with a `dispatch-artifact:{…}` line
 * (`formatArtifactRef`). The transcript card reads the id and version from it —
 * a create's id is minted here, so the call's input cannot carry it.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  ARTIFACT_ASSETS_MAX_FILES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_READ_CONTENT_MAX,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TYPES,
  formatArtifactRef,
  latestArtifactVersion,
  artifactAssetsBytes,
  type ArtifactAsset,
  type ArtifactMeta,
  type ArtifactType,
} from "@dispatch/shared";
import { ArtifactError, type ArtifactAssetInput, type ArtifactEdit } from "../artifacts.js";
import type { ManagerToolDefinition } from "./manager-mcp.js";

/** The artifact store bound to ONE chat (omitted → no artifact tools). */
export interface ManagerMcpArtifacts {
  create(input: {
    title: string;
    type: ArtifactType;
    language?: string;
    content: string;
    assets?: ArtifactAssetInput[];
  }): Promise<ArtifactMeta>;
  update(id: string, change: ArtifactEdit): Promise<ArtifactMeta>;
  read(id: string, version?: number): Promise<{
    meta: ArtifactMeta;
    version: number;
    content: string;
    errors: string[];
    assets?: Record<string, ArtifactAsset>;
  }>;
  list(): Promise<ArtifactMeta[]>;
  /** Where a relative `path` argument is resolved from — the session's working directory. */
  cwd?: string;
  /**
   * The directories a `path` may name a file inside: the chat's cwd, its
   * project checkout and its worktrees. Omitted or empty → no `path` at all.
   */
  roots?: () => Promise<string[]>;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function failure(err: unknown): CallToolResult {
  if (err instanceof ArtifactError) return textResult(err.message, true);
  return textResult(`Artifact error: ${err instanceof Error ? err.message : String(err)}`, true);
}

function refLine(meta: ArtifactMeta): string {
  return formatArtifactRef({ id: meta.id, version: latestArtifactVersion(meta), title: meta.title, type: meta.type });
}

/** True when `child` is `root` or inside it. Both must already be real paths. */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read a `path` argument — but only from inside the chat's own directories.
 *
 * These tools run WITHOUT a permission prompt (they are on the default
 * auto-allow list), and `artifact_read` hands the content straight back to the
 * model. Unconfined, `path` would be a prompt-free `Read` of the whole disk —
 * `~/.ssh/id_rsa` included — that also slips past a mode denying `Read` by
 * name, which is exactly what an agent steered by a hostile issue would reach
 * for. Confined to the trees the chat already works in, it can only publish
 * what the agent could already read there without asking.
 *
 * Both sides go through `realpath`, so a symlink or junction inside the tree
 * that points out of it is judged by where it lands, not where it sits.
 *
 * Bounded BEFORE reading so a mistaken path to a build output or a log is
 * refused by its size, not after buffering it.
 */
async function readSource(ctx: ManagerMcpArtifacts, path: string): Promise<string> {
  const { abs, real } = await confine(ctx, path, await realRootsOf(ctx));
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new ArtifactError("not_found", `No file at ${abs}.`);
  if (info.size > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError("too_large", `${abs} is ${info.size} bytes; the limit is ${ARTIFACT_MAX_BYTES}.`);
  }
  return readFile(real, "utf8");
}

async function realRootsOf(ctx: ManagerMcpArtifacts): Promise<string[]> {
  const roots = await (ctx.roots?.() ?? Promise.resolve([]));
  return (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => !!r);
}

/** Resolve `path` and refuse it unless it really lands inside one of `realRoots`. */
async function confine(
  ctx: ManagerMcpArtifacts,
  path: string,
  realRoots: string[],
): Promise<{ abs: string; real: string }> {
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  const real = await realpath(abs).catch(() => null);
  if (!real) throw new ArtifactError("not_found", `No file at ${abs}.`);
  if (!realRoots.some((root) => isInside(root, real))) {
    throw new ArtifactError(
      "invalid",
      `${abs} is outside this chat's working directories, so it can't be published by path. ` +
        `Pass its content instead if the human should see it.`,
    );
  }
  return { abs, real };
}

/** Never bundled: a repo's history and its dependencies are not what a page loads. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Every file under `dir`, keyed by its path relative to `dir`.
 *
 * Confinement is per FILE, not just per directory: a symlink inside an
 * in-bounds asset folder that points at `~/.ssh` would otherwise ride the
 * folder's approval out to the browser. Anything that resolves outside the
 * chat's trees is refused, which fails the whole call — silently dropping it
 * would publish a page with a hole the agent can't see.
 *
 * Stops counting one past the file limit, so pointing at a home directory by
 * mistake is refused after a bounded walk instead of after listing the disk.
 */
async function collectAssets(
  ctx: ManagerMcpArtifacts,
  dir: string,
  exclude?: string,
): Promise<ArtifactAssetInput[]> {
  const realRoots = await realRootsOf(ctx);
  const { abs, real: root } = await confine(ctx, dir, realRoots);
  const info = await stat(root);
  if (!info.isDirectory()) throw new ArtifactError("invalid", `${abs} is not a directory.`);
  const out: ArtifactAssetInput[] = [];
  const walk = async (here: string): Promise<void> => {
    for (const entry of await readdir(here, { withFileTypes: true })) {
      if (out.length > ARTIFACT_ASSETS_MAX_FILES) return;
      const full = join(here, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const { real } = await confine(ctx, full, realRoots);
      if (!(await stat(real)).isFile()) continue;
      if (exclude && real === exclude) continue;
      out.push({ path: relative(root, full).split(sep).join("/"), file: real });
    }
  };
  await walk(root);
  if (out.length > ARTIFACT_ASSETS_MAX_FILES) {
    throw new ArtifactError(
      "too_large",
      `${abs} has more than ${ARTIFACT_ASSETS_MAX_FILES} files. Point assets_dir at the built output, not a source tree.`,
    );
  }
  return out;
}

/** The main `path` file's real location, so a page sitting inside its own asset folder isn't bundled twice. */
async function realOf(ctx: ManagerMcpArtifacts, path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  return realpath(abs).catch(() => undefined);
}

const ASSETS_GUIDE =
  "A directory of files the page loads — textures, models, audio, wasm, JSON, fonts, a worker " +
  "script. Inside your working directory or a worktree; every file under it is bundled (except " +
  ".git and node_modules), up to 64 MB each and 256 MB in all, and shipped to the viewer before " +
  "the page starts. In the page, name them by their path relative to this directory, exactly as " +
  "you would on a web server: <img src=\"textures/hero.png\">, fetch(\"levels/1.json\"), new " +
  "Worker(\"worker.js\"), WebAssembly.instantiateStreaming(fetch(\"engine.wasm\")), CSS " +
  "url(fonts/a.woff2). For a path built at runtime that none of those see, call " +
  "artifactAsset(\"path\") for a URL. JS assets cannot import each other — bundle scripts into " +
  "one file. html artifacts only.";

const TYPE_GUIDE =
  "'html' — a complete page, rendered in a sandboxed iframe. Inline <script>/<style>, WebGL/WebGL2, " +
  "WebAudio, WebAssembly and Workers created from blob: URLs all work; fetch() works for data: and " +
  "blob: URLs. localStorage works and persists per artifact across reloads and versions (5M " +
  "characters); sessionStorage is per render. There is NO network (no CDN scripts, no http fetch), " +
  "no IndexedDB and no access to Dispatch, so inline every library it needs, and ship larger files " +
  "(textures, models, audio, wasm) as `assets_dir` rather than as data: URLs. 'svg' — one " +
  "<svg> document. 'markdown' — a document. 'code' — a listing shown with highlighting (pass `language`).";

const createShape = {
  title: z.string().min(1).max(ARTIFACT_TITLE_MAX).describe("Short title shown on the card and pane header."),
  type: z.enum(ARTIFACT_TYPES).describe(TYPE_GUIDE),
  content: z.string().optional().describe("The full content. Give this OR `path`."),
  path: z
    .string()
    .optional()
    .describe(
      "A file to publish instead of `content` — inside your working directory or one of this chat's " +
        "worktrees; absolute, or relative to your working directory.",
    ),
  language: z.string().max(32).optional().describe("For type 'code': the language, e.g. 'typescript'."),
  assets_dir: z.string().optional().describe(ASSETS_GUIDE),
};

const updateShape = {
  id: z.string().describe("The artifact id from artifact_create's result."),
  old_str: z.string().optional().describe("Exact text to replace — must occur exactly once in the current version."),
  new_str: z.string().optional().describe("Replacement for old_str."),
  content: z.string().optional().describe("Replace the whole content instead of editing."),
  path: z.string().optional().describe("Or re-publish from a file (absolute, or relative to your working directory)."),
  title: z.string().min(1).max(ARTIFACT_TITLE_MAX).optional().describe("A new title."),
  assets_dir: z
    .string()
    .optional()
    .describe(
      "Re-bundle the page's assets from this directory (see artifact_create). Omitted, the new version " +
        "keeps the previous version's assets unchanged.",
    ),
  clear_assets: z.boolean().optional().describe("Drop all assets from the new version."),
};

const readShape = {
  id: z.string().describe("The artifact id."),
  version: z.number().int().positive().optional().describe("Default: the newest."),
  includeContent: z
    .boolean()
    .optional()
    .describe(`Return the content too (default true; the first ${ARTIFACT_READ_CONTENT_MAX} characters).`),
};

function assetsNote(meta: ArtifactMeta): string {
  const latest = meta.versions[meta.versions.length - 1];
  const assets = latest?.assets;
  if (!assets) return "";
  const n = Object.keys(assets).length;
  return ` with ${n} asset${n === 1 ? "" : "s"} (${formatBytes(artifactAssetsBytes(assets))})`;
}

/** At most this many asset lines in artifact_read — the rest are summarised. */
const ASSET_LIST_MAX = 50;

function describeAssets(assets: Record<string, ArtifactAsset>): string {
  const entries = Object.entries(assets).sort(([a], [b]) => a.localeCompare(b));
  const lines = entries.slice(0, ASSET_LIST_MAX).map(([path, a]) => `- ${path} (${formatBytes(a.size)}, ${a.type})`);
  if (entries.length > ASSET_LIST_MAX) lines.push(`- …and ${entries.length - ASSET_LIST_MAX} more`);
  return `Assets (${entries.length}, ${formatBytes(artifactAssetsBytes(assets))}):\n${lines.join("\n")}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function createArtifactTools(ctx: { artifacts?: ManagerMcpArtifacts }) {
  const unavailable = () => textResult("Artifacts aren't available in this session.", true);

  const artifactCreate: ManagerToolDefinition<typeof createShape> = {
    name: "artifact_create",
    description:
      "Publish an ARTIFACT — a page, SVG, document or code listing the human views in a pane beside " +
      "this chat, instead of reading it as a code block. Use it for anything meant to be LOOKED AT: a " +
      "visual explanation, a report, a prototype UI, a diagram. Each edit makes a new version; the human " +
      "can step back through them. Returns the artifact id for artifact_update. Artifacts expire after a " +
      "few days of no edits, so anything that must last belongs in the repo as well.",
    inputSchema: createShape,
    handler: async (args) => {
      if (!ctx.artifacts) return unavailable();
      if ((args.content === undefined) === (args.path === undefined)) {
        return textResult("Pass exactly one of `content` or `path`.", true);
      }
      try {
        if (args.assets_dir !== undefined && args.type !== "html") {
          return textResult("assets_dir is for html artifacts only.", true);
        }
        const content = args.path !== undefined ? await readSource(ctx.artifacts, args.path) : args.content!;
        const assets =
          args.assets_dir !== undefined
            ? await collectAssets(ctx.artifacts, args.assets_dir, await realOf(ctx.artifacts, args.path))
            : undefined;
        const meta = await ctx.artifacts.create({
          title: args.title,
          type: args.type,
          ...(args.language ? { language: args.language } : {}),
          content,
          ...(assets ? { assets } : {}),
        });
        return textResult(
          `Published "${meta.title}" (${meta.type}) as artifact ${meta.id}, version 1${assetsNote(meta)}. The human sees it ` +
            `in the artifact pane. Edit it with artifact_update; artifact_read reports any runtime errors ` +
            `the viewer caught.\n${refLine(meta)}`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  };

  const artifactUpdate: ManagerToolDefinition<typeof updateShape> = {
    name: "artifact_update",
    description:
      "Make a new version of an artifact: either one exact-match edit (`old_str` → `new_str`, like a " +
      "file edit — prefer this for small changes, it is far cheaper than resending everything), or a " +
      "full replacement (`content` or `path`). `title` alone renames it.",
    inputSchema: updateShape,
    handler: async (args) => {
      if (!ctx.artifacts) return unavailable();
      const modes = [args.old_str !== undefined, args.content !== undefined, args.path !== undefined].filter(Boolean);
      if (modes.length > 1) return textResult("Pass ONE of old_str/new_str, `content` or `path`.", true);
      if (args.old_str !== undefined && args.new_str === undefined) {
        return textResult("old_str needs new_str (use an empty string to delete).", true);
      }
      if (args.assets_dir !== undefined && args.clear_assets) {
        return textResult("Pass assets_dir OR clear_assets, not both.", true);
      }
      const assetsChange = args.assets_dir !== undefined || !!args.clear_assets;
      if (!modes.length && args.title === undefined && !assetsChange) {
        return textResult("Nothing to change — pass an edit, new content, a path, a title or assets.", true);
      }
      try {
        const change: ArtifactEdit = {
          ...(args.clear_assets ? { assets: null } : {}),
          ...(args.assets_dir !== undefined
            ? { assets: await collectAssets(ctx.artifacts, args.assets_dir, await realOf(ctx.artifacts, args.path)) }
            : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.path !== undefined ? { content: await readSource(ctx.artifacts, args.path) } : {}),
          ...(args.old_str !== undefined ? { edit: { oldStr: args.old_str, newStr: args.new_str ?? "" } } : {}),
        };
        const meta = await ctx.artifacts.update(args.id, change);
        const n = latestArtifactVersion(meta);
        return textResult(`Updated "${meta.title}" to version ${n}${assetsNote(meta)}.\n${refLine(meta)}`);
      } catch (err) {
        return failure(err);
      }
    },
  };

  const artifactRead: ManagerToolDefinition<typeof readShape> = {
    name: "artifact_read",
    description:
      "Read an artifact back: its versions, the runtime errors the human's viewer caught while " +
      "rendering it (uncaught exceptions, console.error, blocked resources), and its content. Check " +
      "this after publishing an html artifact — you cannot otherwise see that it threw.",
    inputSchema: readShape,
    handler: async (args) => {
      if (!ctx.artifacts) return unavailable();
      try {
        const got = await ctx.artifacts.read(args.id, args.version);
        const { meta } = got;
        const head =
          `"${meta.title}" (${meta.type}${meta.language ? `, ${meta.language}` : ""}) — version ${got.version} of ` +
          `${meta.versions.map((v) => v.n).join(", ")}`;
        const errors = got.errors.length
          ? `Runtime errors reported for v${got.version}:\n${got.errors.map((e) => `- ${e}`).join("\n")}`
          : `No runtime errors reported for v${got.version} (it may not have been opened yet).`;
        const assetList = got.assets && Object.keys(got.assets).length ? `\n${describeAssets(got.assets)}` : "";
        let body = "";
        if (args.includeContent !== false) {
          // The agent published this, usually from a file it still has. An 8 MB
          // inlined engine read back whole would cost far more than it tells.
          body =
            got.content.length > ARTIFACT_READ_CONTENT_MAX
              ? `\n\n${got.content.slice(0, ARTIFACT_READ_CONTENT_MAX)}\n…[truncated: ${got.content.length} characters in all]`
              : `\n\n${got.content}`;
        }
        return textResult(`${head}\n${errors}${assetList}${body}`);
      } catch (err) {
        return failure(err);
      }
    },
  };

  const artifactList: ManagerToolDefinition<Record<string, never>> = {
    name: "artifact_list",
    description: "List this chat's artifacts — id, title, type, newest version, and whether it has expired.",
    inputSchema: {},
    handler: async () => {
      if (!ctx.artifacts) return unavailable();
      try {
        const metas = await ctx.artifacts.list();
        if (!metas.length) return textResult("This chat has no artifacts.");
        const lines = metas.map(
          (m) =>
            `${m.id}  ${m.type.padEnd(8)} v${latestArtifactVersion(m)}  ${m.title}` +
            (m.expiredAt !== undefined ? "  (expired)" : ""),
        );
        return textResult(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  };

  return { artifactCreate, artifactUpdate, artifactRead, artifactList };
}
