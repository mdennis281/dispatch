/**
 * Clickable code pointers. Assistant messages constantly reference code as
 * "src/foo.ts:69-96", "file.ts:12", or "src/foo.ts L69-96". This module parses
 * those forms out of prose and turns each into a chip that opens the Monaco
 * CodeViewer scrolled to (and highlighting) the referenced line range.
 *
 * Anti-misfire posture, in order of cheapness:
 *   1. The token must end in a known source-file extension (kills URLs like
 *      `example.com:8080`, version strings, times, bare `word:5`).
 *   2. It must carry a line reference (`:N`, `:N-M`, or ` LN[-M]`) — a plain
 *      filename in prose never lights up.
 *   3. It must carry directory context — a bare single-segment relative name
 *      like `Node.js:20` (a version, not a file) stays plain text, since we
 *      can't locate it to a real path anyway (it would open a missing file).
 *      NOTE: this is a structural gate, not a filesystem existence check — the
 *      client has no full file listing to resolve against, so a well-formed
 *      path that doesn't exist can still light up (and open to an empty file).
 *
 * The renderer (Markdown.tsx) only runs this on prose + inline-code text, never
 * inside fenced code blocks, so code samples are left untouched.
 */
import {
  Children,
  Fragment,
  createContext,
  type ReactNode,
} from "react";
import { FileCode2 } from "lucide-react";
import type { Chat, Project, WorktreeInfo } from "@cm/shared";
import {
  openCodeViewer,
  resolveChatFile,
  resolveRepoFile,
  type CodeViewerRequest,
} from "../monaco/index.js";

/* --------------------------------------------------------------- parsing */

/** A parsed code pointer (1-based, inclusive line range). */
export interface CodeRef {
  path: string;
  startLine: number;
  endLine: number;
  /** The exact matched substring (used verbatim as the chip label). */
  raw: string;
}

/**
 * One code-pointer match. The path must be `…/name.ext`; the line spec is
 * either colon-form (`:69`, `:69-96`, `:69:12` col ignored, `:L69`) or the
 * space-`L` form (` L69`, ` L69-96`). Extension is validated against a
 * whitelist below — the regex only requires it to be letter-led.
 */
const CODE_REF_SRC =
  String.raw`(?<path>(?:[\w.@~-]+[/\\])*[\w.@~-]*[\w@~-]\.(?<ext>[A-Za-z][A-Za-z0-9]{0,7}))` +
  String.raw`(?::L?(?<cs>\d+)(?:-(?<ce>\d+))?(?::\d+)?|[ \t]+L(?<ls>\d+)(?:-(?<le>\d+))?)`;

const CODE_REF_RE = new RegExp(CODE_REF_SRC, "g");
const CODE_REF_ANCHORED = new RegExp(`^${CODE_REF_SRC}$`);

/** Source-ish extensions we treat as file pointers. Deliberately excludes TLDs. */
const KNOWN_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "json5",
  "css", "scss", "sass", "less",
  "html", "htm", "xml", "svg",
  "md", "mdx", "txt",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs",
  "php", "swift", "dart", "lua", "ex", "exs", "erl", "clj",
  "sh", "bash", "zsh", "fish", "ps1",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
  "sql", "graphql", "gql", "proto",
  "vue", "svelte", "astro", "zig", "gradle",
]);

/** True when the path carries directory context (absolute or has a separator). */
function hasDirContext(path: string): boolean {
  return /[/\\]/.test(path);
}

function extractRef(
  groups: Record<string, string | undefined>,
  raw: string,
): CodeRef | null {
  const ext = (groups.ext ?? "").toLowerCase();
  if (!KNOWN_EXT.has(ext)) return null;
  const startLine = Number(groups.cs ?? groups.ls);
  if (!Number.isInteger(startLine) || startLine < 1) return null;
  const endRaw = groups.ce ?? groups.le;
  const endLine = endRaw ? Number(endRaw) : startLine;
  return {
    path: groups.path ?? "",
    startLine,
    endLine: Math.max(endLine, startLine),
    raw,
  };
}

/** Parse a whole string as a single code pointer (for inline-code content). */
export function parseWholeCodeRef(raw: string): CodeRef | null {
  const m = CODE_REF_ANCHORED.exec(raw.trim());
  if (!m?.groups) return null;
  return extractRef(m.groups, raw.trim());
}

/** Resolve a whole-string pointer (inline code) to a viewer request, or null. */
export function resolveWholeRef(
  raw: string,
  resolve: CodeRefResolver,
): CodeViewerRequest | null {
  const ref = parseWholeCodeRef(raw);
  return ref ? resolve(ref) : null;
}

/* ------------------------------------------------------------- resolution */

/**
 * Turn a parsed pointer into an openable viewer request, or null if it can't be
 * served. Prefers the chat's worktree (reflects the agent's edits); falls back
 * to the project's repo root. Opens in "file" mode with the line range selected.
 */
export type CodeRefResolver = (ref: CodeRef) => CodeViewerRequest | null;

export function makeCodeRefResolver(
  chat: Chat | undefined,
  worktrees: WorktreeInfo[],
  projects: Project[],
): CodeRefResolver {
  const project = chat ? projects.find((p) => p.id === chat.projectId) : undefined;
  return (ref) => {
    // Bare single-segment relative names (`Node.js:20`, `helper.ts:1`) can't be
    // located to the right file — they'd resolve to <worktree>/<name> and open a
    // missing file. Require directory context and leave them as prose.
    if (!hasDirContext(ref.path)) return null;
    const target =
      resolveChatFile(chat, worktrees, ref.path) ??
      resolveRepoFile(project?.repoPath, project?.defaultBranch, ref.path);
    if (!target) return null;
    return {
      worktreePath: target.worktreePath,
      relPath: target.relPath,
      base: target.base,
      branch: target.branch,
      mode: "file",
      selection: { startLine: ref.startLine, endLine: ref.endLine },
    };
  };
}

/* ------------------------------------------------------------- rendering */

/** Resolver in scope for the assistant markdown being rendered (null = off). */
export const CodeRefContext = createContext<CodeRefResolver | null>(null);

/** A clickable code-pointer chip — opens the Monaco preview at the range. */
export function CodeRefChip({
  label,
  request,
}: {
  label: string;
  request: CodeViewerRequest;
}) {
  const range =
    request.selection && request.selection.endLine !== request.selection.startLine
      ? `${request.selection.startLine}-${request.selection.endLine}`
      : request.selection?.startLine;
  return (
    <button
      type="button"
      onClick={() => openCodeViewer(request)}
      title={`Open ${request.relPath}${range ? `:${range}` : ""}`}
      className="inline-flex items-center gap-1 rounded-[4px] border border-accent-line/70 bg-accent-ghost px-1 py-px align-baseline cm-mono !text-[11.5px] text-accent-hi transition-colors hover:border-accent hover:bg-accent-ghost/80 hover:text-accent-hi [&_svg]:size-3 [&_svg]:-mb-px [&_svg]:opacity-80"
    >
      <FileCode2 />
      {label}
    </button>
  );
}

/** Split one plain-text string into text + code-pointer chips. */
export function linkifyCodeRefs(text: string, resolve: CodeRefResolver): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(CODE_REF_RE)) {
    const idx = m.index ?? 0;
    const full = m[0];
    const ref = extractRef(m.groups ?? {}, full);
    if (!ref) continue;
    const request = resolve(ref);
    if (!request) continue; // unresolvable → leave as prose
    if (idx > last) out.push(text.slice(last, idx));
    out.push(<CodeRefChip key={`cr${key++}`} label={full} request={request} />);
    last = idx + full.length;
  }
  if (out.length === 0) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Walk React children, linkifying only string leaves. Nested elements are left
 * intact — their own renderer re-enters this pass, so nothing is double-scanned.
 */
export function linkifyChildren(children: ReactNode, resolve: CodeRefResolver): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child !== "string") return child;
    const parts = linkifyCodeRefs(child, resolve);
    if (parts.length === 1 && typeof parts[0] === "string") return child;
    return <Fragment key={i}>{parts}</Fragment>;
  });
}
