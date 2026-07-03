/** Map a file path/extension to a Monaco language id (best-effort, read-only). */

const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  lua: "lua",
  r: "r",
  dart: "dart",
  proto: "proto",
  txt: "plaintext",
  log: "plaintext",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "plaintext",
  ".gitignore": "plaintext",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/** Filenames whose extension implies a raster/vector image for inline preview. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function ext(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** Monaco language id for a path (defaults to "plaintext"). */
export function languageForPath(path: string): string {
  const name = baseName(path).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name]!;
  return BY_EXT[ext(path)] ?? "plaintext";
}

/** True when the path looks like an image we can preview inline (not as text). */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(ext(path));
}

/** Guess an image mime for a base64 inline preview data URL. */
export function imageMimeForPath(path: string): string {
  const e = ext(path);
  if (e === "svg") return "image/svg+xml";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "ico") return "image/x-icon";
  return `image/${e || "png"}`;
}
