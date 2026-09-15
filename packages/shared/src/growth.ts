/**
 * Codebase growth — the shape of a repo's line count over its history, and the
 * one classification rule that keeps that number honest.
 *
 * WHY THIS IS ITS OWN LEDGER. The Metrics screen's other three tabs read what
 * Dispatch RECORDED (tool calls, spans, process tables). This one reads what
 * git recorded — `git log --numstat` over the trunk's first-parent chain — so
 * it is computed on demand from the repo and never stored: the answer is
 * already durable in `.git`, and a cache of it would be a second copy that can
 * only ever be stale.
 *
 * FIRST-PARENT, NOT EVERY COMMIT. Walking every reachable commit counts a
 * branch's work twice if it later merges with conflict resolution, and once a
 * squash-merged repo is mixed with a merge-commit one the sum stops matching
 * the tree. The first-parent chain is the sequence of states the TRUNK has
 * been in, each merge contributing exactly the diff it landed, so the running
 * net of additions − deletions over it IS the line count at HEAD (for text
 * files — binaries have no lines and are counted separately).
 *
 * ── THE NUMBER THAT LIES ─────────────────────────────────────────────────────
 *
 * A raw numstat says this very repo grew by 14,000 lines the day someone ran
 * `pnpm install`. Lockfiles, minified bundles and vendored trees are the bulk of
 * most repos' additions and none of their code, which is why GitHub's own graph
 * runs every path through linguist first. {@link classifyPath} is the
 * equivalent here: every file gets a KEY that is either its extension (`.ts`),
 * its bare name when it has none (`Dockerfile`), or the reserved
 * {@link GROWTH_GENERATED_KEY} when it is a lockfile / build output / minified
 * asset. The server buckets by that key and knows nothing else; the client
 * folds keys into languages with {@link languageOf} and hides the generated
 * bucket unless asked, so the toggle costs no second walk.
 */

/* --------------------------------------------------------------- the keys */

/**
 * The bucket every generated path lands in.
 *
 * A `!` prefix rather than a fake extension so it can never collide with a
 * real one (`.lock` is a real extension; `!generated` is not a path suffix any
 * file can have) and sorts away from them.
 */
export const GROWTH_GENERATED_KEY = "!generated";

/** The bucket for a file that has no extension and no recognisable name. */
export const GROWTH_NO_EXT_KEY = "!none";

/** Basenames that are lockfiles, whichever ecosystem. Case-insensitive. */
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "podfile.lock",
  "gradle.lockfile",
]);

/**
 * Directory segments that mark build output or vendored code. Matched against
 * every segment, not just the first — a monorepo has a `dist/` per package.
 */
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "third_party",
  "__snapshots__",
  ".yarn",
  "coverage",
  "target",
]);

/** Suffixes that mean "a tool wrote this", before the extension is read. */
const GENERATED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".bundle.js",
  ".map",
  ".snap",
  ".generated.ts",
  ".g.ts",
  ".pb.go",
  ".pb.ts",
  "_pb2.py",
  ".d.ts.map",
];

/**
 * Extension-less files that a reader still recognises by name. Keyed on the
 * lowercase basename; the value is the key the file buckets under.
 */
const NAMED_FILES: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  gnumakefile: "Makefile",
  rakefile: "Rakefile",
  gemfile: "Gemfile",
  procfile: "Procfile",
  license: "LICENSE",
  licence: "LICENSE",
  readme: "README",
  changelog: "CHANGELOG",
  codeowners: "CODEOWNERS",
  jenkinsfile: "Jenkinsfile",
  vagrantfile: "Vagrantfile",
  brewfile: "Brewfile",
  justfile: "justfile",
};

/**
 * Classify one repo-relative path into its growth bucket.
 *
 * Pure and total: any string in, a key out. The path may still be in git's
 * rename form (`a/{b => c}/d.ts`) — the caller normalises that first, because
 * the extension of the NEW name is the one that matters going forward.
 */
export function classifyPath(path: string): string {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);

  if (LOCKFILES.has(base)) return GROWTH_GENERATED_KEY;
  if (dirs.some((d) => GENERATED_DIRS.has(d))) return GROWTH_GENERATED_KEY;
  if (GENERATED_SUFFIXES.some((s) => base.endsWith(s))) return GROWTH_GENERATED_KEY;

  const named = NAMED_FILES[base];
  if (named) return named;

  // `.gitignore` is an extension-less dotfile, not a file with extension
  // `gitignore` — so the dot has to be past position 0 to count.
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    // Dotfiles keep their name as the key (`.gitignore`, `.npmrc`): they are a
    // recognisable family and a reader would not know what `!none` held.
    return dot === 0 ? base : GROWTH_NO_EXT_KEY;
  }
  return base.slice(dot);
}

/* ---------------------------------------------------------------- languages */

/**
 * The extension → language table.
 *
 * Deliberately small: the point is that `.ts` and `.tsx` are ONE series, not
 * an exhaustive linguist port. An extension not listed here becomes its own
 * language under its own name, which is the honest answer for `.proto` in a
 * repo with three of them.
 */
const LANGUAGES: Record<string, string[]> = {
  TypeScript: [".ts", ".tsx", ".mts", ".cts"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
  Python: [".py", ".pyi", ".pyx"],
  Rust: [".rs"],
  Go: [".go"],
  Java: [".java"],
  Kotlin: [".kt", ".kts"],
  Swift: [".swift"],
  "C#": [".cs"],
  C: [".c", ".h"],
  "C++": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  Ruby: [".rb", ".rake", "Gemfile", "Rakefile"],
  PHP: [".php"],
  Dart: [".dart"],
  Scala: [".scala"],
  Elixir: [".ex", ".exs"],
  Erlang: [".erl", ".hrl"],
  Haskell: [".hs"],
  Lua: [".lua"],
  Zig: [".zig"],
  Shell: [".sh", ".bash", ".zsh", ".fish"],
  PowerShell: [".ps1", ".psm1", ".psd1"],
  Batch: [".bat", ".cmd"],
  HTML: [".html", ".htm"],
  CSS: [".css", ".scss", ".sass", ".less", ".pcss"],
  Vue: [".vue"],
  Svelte: [".svelte"],
  Astro: [".astro"],
  SQL: [".sql"],
  GraphQL: [".graphql", ".gql"],
  Protobuf: [".proto"],
  Markdown: [".md", ".mdx", ".markdown", "README", "CHANGELOG"],
  JSON: [".json", ".jsonc", ".json5"],
  YAML: [".yml", ".yaml"],
  TOML: [".toml"],
  XML: [".xml", ".xsl", ".xsd", ".plist", ".svg"],
  Config: [
    ".ini",
    ".cfg",
    ".conf",
    ".env",
    ".editorconfig",
    ".gitignore",
    ".gitattributes",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
    ".dockerignore",
    "CODEOWNERS",
  ],
  Docker: ["Dockerfile", ".dockerfile"],
  Make: ["Makefile", "justfile"],
  Terraform: [".tf", ".tfvars", ".hcl"],
  Nix: [".nix"],
  Text: [".txt", "LICENSE"],
  CSV: [".csv", ".tsv"],
  Jupyter: [".ipynb"],
  "Objective-C": [".m", ".mm"],
  R: [".r", ".rmd"],
  Julia: [".jl"],
  Clojure: [".clj", ".cljs", ".cljc", ".edn"],
  "F#": [".fs", ".fsx"],
  OCaml: [".ml", ".mli"],
  Perl: [".pl", ".pm"],
  Groovy: [".groovy", ".gradle"],
  Solidity: [".sol"],
  Assembly: [".s", ".asm"],
  WebAssembly: [".wat", ".wast"],
  CMake: [".cmake"],
  Handlebars: [".hbs", ".handlebars"],
  Liquid: [".liquid"],
  Twig: [".twig"],
  Pug: [".pug", ".jade"],
  EJS: [".ejs"],
  Nunjucks: [".njk"],
  Mustache: [".mustache"],
  LaTeX: [".tex", ".bib"],
  Prisma: [".prisma"],
};

/** Reverse of {@link LANGUAGES}, built once. */
const LANGUAGE_OF: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [lang, keys] of Object.entries(LANGUAGES)) {
    for (const k of keys) map[k] = lang;
  }
  return map;
})();

/** The language label for a generated bucket. */
export const GROWTH_GENERATED_LABEL = "Generated";

/**
 * Resolve a growth key (from {@link classifyPath}) to a language name.
 *
 * `!generated` and `!none` get spelled-out labels; an unlisted extension reads
 * as itself (`.proto`), which is a better label than "Other" for a series the
 * reader can see is small and specific.
 */
export function languageOf(key: string): string {
  if (key === GROWTH_GENERATED_KEY) return GROWTH_GENERATED_LABEL;
  if (key === GROWTH_NO_EXT_KEY) return "(no extension)";
  return LANGUAGE_OF[key] ?? key;
}

/** How a growth key reads when the split is by EXTENSION rather than language. */
export function extensionLabel(key: string): string {
  if (key === GROWTH_GENERATED_KEY) return GROWTH_GENERATED_LABEL;
  if (key === GROWTH_NO_EXT_KEY) return "(no extension)";
  return key;
}

/* ------------------------------------------------------------------- wire */

/** Additions and deletions for one thing — a bucket, a commit, a language. */
export interface GrowthDelta {
  additions: number;
  deletions: number;
}

/**
 * One UTC day of trunk history.
 *
 * Daily on the wire, whatever the chart shows. A day is the finest bucket
 * anyone reads a growth curve at, and the client can always widen — but a
 * week sent from the server could never be split back into its days when the
 * range narrows to a month.
 */
export interface GrowthPoint extends GrowthDelta {
  /** Day start, UTC ms. */
  ts: number;
  commits: number;
  /** The day's additions/deletions per growth key, only keys that moved. */
  keys: Record<string, GrowthDelta>;
}

/** One of the commits that moved the most lines — the "what was that spike". */
export interface GrowthNotableCommit extends GrowthDelta {
  sha: string;
  /** Committer time, UTC ms — when it landed on the trunk, not when it was authored. */
  ts: number;
  subject: string;
  author: string;
  /** Text files touched. */
  files: number;
}

/** Everything the Growth tab renders, for one repo. */
export interface GrowthReport {
  projectId: string;
  /** The ref that was walked (branch name, or the short sha when detached). */
  ref: string;
  /** Commits on the first-parent chain. */
  commits: number;
  /** Distinct author names across those commits. */
  authors: number;
  /** Committer time of the oldest / newest commit on the chain, UTC ms. */
  firstTs: number;
  lastTs: number;
  /** Oldest → newest. */
  points: GrowthPoint[];
  /**
   * Whole-history totals per growth key, so the composition table does not
   * have to re-sum the points, and the per-key file count which the points
   * do not carry.
   */
  totals: Record<string, GrowthDelta & { files: number }>;
  /** Largest commits by lines moved, most first. Capped by the server. */
  notable: GrowthNotableCommit[];
  /** Binary-file entries skipped — they have no line count to add. */
  binaries: number;
  /** When the walk ran and how long it took. Shown so "no cache" is visible. */
  generatedAt: number;
  elapsedMs: number;
}

/** What streams back while the walk is running. */
export type GrowthProgress =
  | { phase: "counting" }
  | { phase: "walking"; done: number; total: number };

/**
 * One line of the NDJSON stream. Progress frames repeat; exactly one `result`
 * or `error` frame ends it.
 */
export type GrowthFrame =
  | { type: "progress"; progress: GrowthProgress }
  | { type: "result"; report: GrowthReport }
  | { type: "error"; error: string };
