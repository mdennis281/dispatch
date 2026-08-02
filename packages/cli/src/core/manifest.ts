/**
 * manifest — locate and safely edit a repo's `.claude-manager/project.yaml`.
 *
 * `project.yaml` is a HAND-AUTHORED, committable file: contributors write it,
 * review it in PRs, and comment it. So every edit here goes through the `yaml`
 * package's Document API rather than a parse → mutate-JS → re-serialize round
 * trip, which would silently strip every comment and reflow the whole file. Only
 * the nodes an operation actually touches are rewritten; the rest of the document
 * — key order, blank lines, comments — survives byte-for-byte.
 *
 * Two invariants hold for every write:
 *   - the resulting document is re-validated against {@link ProjectManifestSchema}
 *     BEFORE it hits disk, so the CLI can never author a manifest the server's
 *     loader would then reject, and
 *   - the write is atomic (tmp file + rename), so a crash mid-write can't leave a
 *     project with a truncated config.
 */
import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, resolve, parse as parsePath } from "node:path";
import { Document, isSeq, parseDocument, type YAMLSeq } from "yaml";
import {
  CONFIG_DIR_NAME,
  MANIFEST_FILE,
  ProjectManifestSchema,
  type ProjectManifest,
} from "@cm/shared";

/** Raised for every expected, user-facing failure (bad args, missing server). */
export class CmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmError";
  }
}

/* ------------------------------------------------------------- discovery */

/** Where a project's config lives, and whether it exists yet. */
export interface ProjectPaths {
  /** Absolute repo root (the dir that holds — or would hold — the config dir). */
  root: string;
  /** Absolute `<root>/.claude-manager`. */
  configDir: string;
  /** Absolute `<configDir>/project.yaml`. */
  manifestPath: string;
  /** Whether `project.yaml` already exists. */
  exists: boolean;
}

/**
 * Resolve the project whose config an invocation targets, by walking UP from
 * `startDir`. An existing `.claude-manager/` always wins; failing that, the
 * nearest `.git` marks the repo root (so `cm mcp add` from a nested package dir
 * still writes to the one config at the top). With neither marker anywhere up the
 * tree, `startDir` itself is the root — `cm mcp add` in a fresh directory just
 * creates the config there.
 */
export function resolveProjectPaths(startDir: string): ProjectPaths {
  const start = resolve(startDir);
  const { root: fsRoot } = parsePath(start);
  let gitRoot: string | null = null;

  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_DIR_NAME))) return pathsFor(dir);
    if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir;
    if (dir === fsRoot) break;
  }
  return pathsFor(gitRoot ?? start);
}

function pathsFor(root: string): ProjectPaths {
  const configDir = join(root, CONFIG_DIR_NAME);
  const manifestPath = join(configDir, MANIFEST_FILE);
  return { root, configDir, manifestPath, exists: existsSync(manifestPath) };
}

/* --------------------------------------------------------------- reading */

/** A loaded manifest document plus where it came from. */
export interface LoadedManifest {
  paths: ProjectPaths;
  /** The live YAML document — edit this, then hand it to {@link saveManifest}. */
  doc: Document;
  /** False when the document was synthesized because no file existed yet. */
  existed: boolean;
}

/**
 * Load `project.yaml` as an editable document. When the file doesn't exist a
 * MINIMAL in-memory document is synthesized (`name: <repo dir name>`) so the
 * caller can add to it and save — first `cm mcp add` in a repo scaffolds the
 * config instead of erroring. Nothing is written until {@link saveManifest}.
 */
export async function loadManifest(startDir: string): Promise<LoadedManifest> {
  const paths = resolveProjectPaths(startDir);
  if (!paths.exists) {
    const doc = new Document({ name: basename(paths.root) });
    doc.commentBefore =
      " claude-manager project config — the committable source of truth for how\n" +
      " agents run on this repo. Edit MCP servers with `cm mcp`; see ./README.md.";
    return { paths, doc, existed: false };
  }

  const raw = await readFile(paths.manifestPath, "utf8");
  const doc = parseDocument(raw);
  if (doc.errors.length) {
    throw new CmError(
      `${paths.manifestPath} is not valid YAML: ${doc.errors[0]?.message ?? "parse error"}`,
    );
  }
  // A manifest that's already invalid would make every later edit fail validation
  // with a confusing message. Surface the real problem now, pointing at the file.
  const parsed = ProjectManifestSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    throw new CmError(
      `${paths.manifestPath} is not a valid project manifest:\n${formatZodIssues(parsed.error)}`,
    );
  }
  return { paths, doc, existed: true };
}

/* --------------------------------------------------------------- writing */

/**
 * Validate the edited document and write it atomically. Returns the manifest
 * path. Validation runs against the SAME schema the server's loader uses, so a
 * successful `cm` command guarantees the server can load the result.
 */
export async function saveManifest(loaded: LoadedManifest): Promise<string> {
  const parsed = ProjectManifestSchema.safeParse(loaded.doc.toJS() ?? {});
  if (!parsed.success) {
    throw new CmError(
      `Refusing to write an invalid manifest:\n${formatZodIssues(parsed.error)}`,
    );
  }
  const { manifestPath, configDir } = loaded.paths;
  await mkdir(configDir, { recursive: true });
  // tmp + rename: a crash mid-write leaves the previous config intact rather
  // than a half-written file that breaks every session in the project.
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(tmp, loaded.doc.toString({ lineWidth: 0 }), "utf8");
  await rename(tmp, manifestPath);
  return manifestPath;
}

/** Render zod issues as `  path: message` lines. */
export function formatZodIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/* ------------------------------------------------------------ seq access */

/**
 * Get the document's `mcpServers` sequence node, creating an empty one when the
 * key is absent (`create`) or returning null when it isn't there. Throws when the
 * key exists but holds something other than a list, rather than clobbering it.
 */
export function mcpServersSeq(doc: Document, create: true): YAMLSeq;
export function mcpServersSeq(doc: Document, create?: false): YAMLSeq | null;
export function mcpServersSeq(doc: Document, create = false): YAMLSeq | null {
  const node = doc.get("mcpServers", true);
  if (node === undefined || node === null) {
    if (!create) return null;
    const seq = doc.createNode([]) as YAMLSeq;
    doc.set("mcpServers", seq);
    return seq;
  }
  if (!isSeq(node)) {
    throw new CmError(
      "`mcpServers` in project.yaml is not a list — fix it by hand before using `cm mcp`.",
    );
  }
  return node;
}

/** The plain-JS view of the manifest (for read-only listing). */
export function manifestJs(doc: Document): ProjectManifest | null {
  const parsed = ProjectManifestSchema.safeParse(doc.toJS() ?? {});
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------ scaffolding */

/** A short README dropped next to a freshly scaffolded manifest. */
const CONFIG_README = `# .claude-manager

This directory is the committable source of truth for how claude-manager runs
agents on this repo. It is read by the manager at startup and re-read live
whenever a file here changes.

- \`project.yaml\` — the manifest: MCP servers, sub-apps, instructions, defaults.
- \`instructions/\` — markdown appended to every session's system prompt.
- \`agents/\` — custom agent definitions (\`*.md\` with frontmatter).
- \`modes/\` — permission/tool presets (\`*.yaml\`).
- \`skills/\` — skills materialized into sessions (\`<name>/SKILL.md\`).
- \`memory/\` — durable project memory.

## MCP servers

Add them with the CLI rather than hand-editing:

    cm mcp add <name> -- <command> [args...]      # stdio
    cm mcp add <name> --transport http --url <url>
    cm mcp list
    cm mcp remove <name>

Secrets belong in \`\${VAR}\` placeholders, which are expanded from the manager
process's environment when a session starts — so this file stays safe to commit.
`;

/**
 * Write a starter `README.md` alongside a newly created config dir. Best-effort
 * and never clobbers an existing file — it's a convenience, not a guarantee.
 */
export async function ensureConfigReadme(configDir: string): Promise<void> {
  const target = join(configDir, "README.md");
  if (existsSync(target)) return;
  try {
    await mkdir(configDir, { recursive: true });
    // Only seed the README for a genuinely fresh config dir; a repo that already
    // authored instructions/agents doesn't want our boilerplate dropped in.
    const entries = await readdir(configDir);
    if (entries.some((e) => e !== MANIFEST_FILE && !e.endsWith(".tmp"))) return;
    await writeFile(target, CONFIG_README, "utf8");
  } catch {
    /* best-effort */
  }
}
