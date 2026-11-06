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
import { isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TYPES,
  formatArtifactRef,
  latestArtifactVersion,
  type ArtifactMeta,
  type ArtifactType,
} from "@dispatch/shared";
import { ArtifactError, type ArtifactEdit } from "../artifacts.js";
import type { ManagerToolDefinition } from "./manager-mcp.js";

/** The artifact store bound to ONE chat (omitted → no artifact tools). */
export interface ManagerMcpArtifacts {
  create(input: { title: string; type: ArtifactType; language?: string; content: string }): Promise<ArtifactMeta>;
  update(id: string, change: ArtifactEdit): Promise<ArtifactMeta>;
  read(id: string, version?: number): Promise<{ meta: ArtifactMeta; version: number; content: string; errors: string[] }>;
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
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  const roots = await (ctx.roots?.() ?? Promise.resolve([]));
  const realRoots = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter(
    (r): r is string => !!r,
  );
  const real = await realpath(abs).catch(() => null);
  if (!real) throw new ArtifactError("not_found", `No file at ${abs}.`);
  if (!realRoots.some((root) => isInside(root, real))) {
    throw new ArtifactError(
      "invalid",
      `${abs} is outside this chat's working directories, so it can't be published by path. ` +
        `Pass its content instead if the human should see it.`,
    );
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new ArtifactError("not_found", `No file at ${abs}.`);
  if (info.size > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError("too_large", `${abs} is ${info.size} bytes; the limit is ${ARTIFACT_MAX_BYTES}.`);
  }
  return readFile(real, "utf8");
}

const TYPE_GUIDE =
  "'html' — a complete page, rendered in a sandboxed iframe. Inline <script>/<style>, WebGL/WebGL2, " +
  "WebAudio, WebAssembly and Workers created from blob: URLs all work; fetch() works for data: and " +
  "blob: URLs. localStorage works and persists per artifact across reloads and versions (5M " +
  "characters); sessionStorage is per render. There is NO network (no CDN scripts, no http fetch), " +
  "no IndexedDB and no access to Dispatch, so inline every library and asset it needs. 'svg' — one " +
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
};

const updateShape = {
  id: z.string().describe("The artifact id from artifact_create's result."),
  old_str: z.string().optional().describe("Exact text to replace — must occur exactly once in the current version."),
  new_str: z.string().optional().describe("Replacement for old_str."),
  content: z.string().optional().describe("Replace the whole content instead of editing."),
  path: z.string().optional().describe("Or re-publish from a file (absolute, or relative to your working directory)."),
  title: z.string().min(1).max(ARTIFACT_TITLE_MAX).optional().describe("A new title."),
};

const readShape = {
  id: z.string().describe("The artifact id."),
  version: z.number().int().positive().optional().describe("Default: the newest."),
  includeContent: z.boolean().optional().describe("Return the content too (default true)."),
};

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
        const content = args.path !== undefined ? await readSource(ctx.artifacts, args.path) : args.content!;
        const meta = await ctx.artifacts.create({
          title: args.title,
          type: args.type,
          ...(args.language ? { language: args.language } : {}),
          content,
        });
        return textResult(
          `Published "${meta.title}" (${meta.type}) as artifact ${meta.id}, version 1. The human sees it ` +
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
      if (!modes.length && args.title === undefined) {
        return textResult("Nothing to change — pass an edit, new content, a path or a title.", true);
      }
      try {
        const change: ArtifactEdit = {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.path !== undefined ? { content: await readSource(ctx.artifacts, args.path) } : {}),
          ...(args.old_str !== undefined ? { edit: { oldStr: args.old_str, newStr: args.new_str ?? "" } } : {}),
        };
        const meta = await ctx.artifacts.update(args.id, change);
        const n = latestArtifactVersion(meta);
        return textResult(`Updated "${meta.title}" to version ${n}.\n${refLine(meta)}`);
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
        const body = args.includeContent === false ? "" : `\n\n${got.content}`;
        return textResult(`${head}\n${errors}${body}`);
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
