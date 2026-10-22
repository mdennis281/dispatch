/**
 * Build a {@link PluginInspection} from a plugin directory on disk — the
 * scratch copy `fetch.ts` extracted, or (in tests) an example under
 * `examples/plugins/`. Reads files; imports, requires, builds and runs nothing.
 *
 * Every file read goes through `readConfined`: lexical containment, then
 * `lstat` (no symlinks), then `realpath` containment, then a size cap. The
 * extractor already refuses to write links, so this is the second wall, and
 * it is what keeps the function safe to point at a directory nobody vetted.
 *
 * The manifest is judged by the host's OWN schema (`PluginManifestSchema`,
 * `pluginRangeAccepts`, the contribution file schemas) — the report must never
 * call valid what the loader would list as invalid, or the reverse.
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_LINES,
  PLUGIN_MANIFEST_FILE,
  PluginManifestSchema,
  PluginMcpServersFileSchema,
  PluginProcessesFileSchema,
  manifestPathDir,
  pluginRangeAccepts,
  referencedSecrets,
  type PluginCapability,
  type PluginInspection,
  type PluginInspectionSource,
  type PluginManifest,
  type PluginStatus,
} from "@dispatch/shared";
import { assertValidServerName } from "@dispatch/cli/core";
import { readInstructionsDir, readSkillsDir } from "../../services/authored-config.js";
import { readModesDir } from "../../services/mcp/mode-editor.js";
import { SCAN_NOTE, runtimeNpmImports, scanFiles } from "./scan.js";

/** Scan budget — separate from the fetch caps because it is about CPU, not disk. */
export const SCAN_LIMITS = { maxFiles: 400, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 };
const MANIFEST_MAX_BYTES = 256 * 1024;
const CODE_FILE = /\.(?:[mc]?[jt]sx?)$/i;
const NOT_SCANNED = /(?:^|\/)(?:test|tests|__tests__|__mocks__|node_modules|\.git)\/|\.(?:test|spec)\.[mc]?[jt]sx?$|\.d\.[mc]?ts$|(?:^|\/)(?:vite|vitest|rollup|webpack|eslint|tsup)\.config\.[mc]?[jt]s$/i;

export interface InstalledLookup {
  version?: string;
  status?: PluginStatus;
  needsRestart?: boolean;
  linked?: boolean;
}

export interface InspectDirOptions {
  source: PluginInspectionSource;
  fetched: PluginInspection["fetched"];
  /** What is installed under the same id, if anything. */
  installed?: (id: string) => Promise<InstalledLookup | undefined>;
}

class Confined {
  private constructor(readonly root: string) {}
  static async at(dir: string): Promise<Confined> {
    return new Confined(await realpath(resolve(dir)));
  }
  private inside(p: string): boolean {
    return p === this.root || p.startsWith(this.root + sep);
  }
  /** Absolute path of `rel` if it stays inside, else null. Lexical only. */
  path(rel: string): string | null {
    const abs = resolve(this.root, rel);
    return this.inside(abs) ? abs : null;
  }
  /** Is `rel` a regular file (not a link) whose real path is inside? */
  async isFile(rel: string): Promise<boolean> {
    const abs = this.path(rel);
    if (!abs) return false;
    try {
      const st = await lstat(abs);
      return st.isFile() && this.inside(await realpath(abs));
    } catch {
      return false;
    }
  }
  /** A directory inside (real path checked) — for the contribution readers. */
  async dir(rel: string): Promise<string | null> {
    const abs = this.path(rel);
    if (!abs) return null;
    try {
      const st = await lstat(abs);
      if (!st.isDirectory()) return null;
      const real = await realpath(abs);
      return this.inside(real) ? real : null;
    } catch {
      return null;
    }
  }
  /** Read a confined regular file, or null (missing, a link, outside, or over `max`). */
  async read(rel: string, max: number): Promise<string | null> {
    const abs = this.path(rel);
    if (!abs) return null;
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size > max) return null;
      if (!this.inside(await realpath(abs))) return null;
      return await readFile(abs, "utf8");
    } catch {
      return null;
    }
  }
  /** Every regular file under the root, relative with `/`, links and VCS/deps dirs skipped. */
  async walk(limit: number): Promise<string[]> {
    const out: string[] = [];
    const visit = async (abs: string): Promise<void> => {
      if (out.length >= limit) return;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= limit) return;
        if (e.isSymbolicLink()) continue;
        const child = join(abs, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          await visit(child);
        } else if (e.isFile()) {
          out.push(relative(this.root, child).split(sep).join("/"));
        }
      }
    };
    await visit(this.root);
    return out;
  }
}

/** `./server/index.js` → `server/index.js`. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Semver-ish x.y.z comparison; prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/**
 * The opening prose of a README: title, badges, HTML comments and images
 * dropped; stops at the first code fence, the second heading, or ~900 chars.
 */
export function readmeExcerpt(md: string, max = 900): string {
  // To a fixed point, and an unclosed `<!--` runs to the end: one pass over
  // `<!<!---->--` leaves a fresh `<!--` behind. The excerpt is rendered as
  // text, never HTML, but a stray comment opener is still not prose.
  let src = md.replace(/\r\n/g, "\n");
  for (let prev = ""; prev !== src; ) {
    prev = src;
    src = src.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  }
  const lines = src.split("\n");
  const out: string[] = [];
  let headings = 0;
  let len = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```|^~~~/.test(line.trim())) {
      if (out.some((l) => l.trim())) break;
      continue;
    }
    if (!out.length && /^#\s/.test(line)) continue;
    if (/^\s*(\[!\[|!\[|<img|<p align|<\/?(?:div|p|picture|source)\b)/i.test(line)) continue;
    if (/^#{1,6}\s/.test(line)) {
      headings += 1;
      if (headings > 1 && out.some((l) => l.trim())) break;
    }
    if (!line.trim() && !out.length) continue;
    out.push(line);
    len += line.length + 1;
    if (len >= max) break;
  }
  // The card shows plain text, not rendered markdown: unwrap hard-wrapped
  // paragraphs (a README wrapped at 80 columns otherwise renders as a narrow
  // ragged column) and drop inline markup that would show as literal `**`.
  const paragraphs = out
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => {
      const ls = p.split("\n").map((l) => l.trim()).filter(Boolean);
      const listy = ls.some((l) => /^([-*+]|\d+\.)\s/.test(l));
      return listy ? ls.join("\n") : ls.join(" ");
    })
    .filter(Boolean)
    .map((p) =>
      p
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^#{1,6}\s+/gm, ""),
    );
  let text = paragraphs.join("\n\n").trim();
  if (text.length > max) text = `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return text;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Files the hooks scan reads: the entries' directories, the usual source roots, and code a contribution runs. */
function scanTargets(all: string[], m: PluginManifest | undefined, contributionFiles: string[]): string[] {
  const roots = new Set(["src", "dist", "lib", "build"]);
  const singles = new Set(contributionFiles.map(norm));
  for (const entry of [m?.server, m?.client]) {
    if (!entry) continue;
    const d = manifestPathDir(entry);
    if (d) roots.add(d);
    else singles.add(norm(entry));
  }
  return all.filter(
    (f) =>
      CODE_FILE.test(f) &&
      !NOT_SCANNED.test(f) &&
      (singles.has(f) || [...roots].some((r) => f.startsWith(`${r}/`))),
  );
}

/** Relative code paths named in a stdio command / args (`node ./mcp/echo-server.mjs`). */
function codePathsIn(command: string | undefined, args: string[] | undefined): string[] {
  return [command ?? "", ...(args ?? [])].filter((a) => CODE_FILE.test(a) && !/^[a-z]+:/i.test(a) && !a.includes("$"));
}

export async function inspectPluginDir(dir: string, opts: InspectDirOptions): Promise<PluginInspection> {
  const fs = await Confined.at(dir);
  const errors: string[] = [];
  const warnings: string[] = [];

  /* -- manifest ------------------------------------------------------- */
  const raw = await fs.read(PLUGIN_MANIFEST_FILE, MANIFEST_MAX_BYTES);
  let doc: Record<string, unknown> = {};
  if (raw === null) {
    errors.push(`${PLUGIN_MANIFEST_FILE} could not be read (missing, a link, or over ${MANIFEST_MAX_BYTES} bytes)`);
  } else {
    try {
      const parsedDoc: unknown = parseYaml(raw);
      if (parsedDoc && typeof parsedDoc === "object" && !Array.isArray(parsedDoc)) doc = parsedDoc as Record<string, unknown>;
      else errors.push(`${PLUGIN_MANIFEST_FILE} is not a mapping`);
    } catch (err) {
      errors.push(`${PLUGIN_MANIFEST_FILE} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let m: PluginManifest | undefined;
  if (!errors.length) {
    const parsed = PluginManifestSchema.safeParse(doc);
    if (parsed.success) m = parsed.data;
    else for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  const range = str(doc.dispatch);
  const compatible = range ? pluginRangeAccepts(range, PLUGIN_API_VERSION) : false;
  const valid = !!m;
  const id = m?.id ?? str(doc.id);

  /* -- entries -------------------------------------------------------- */
  const entries: PluginInspection["entries"] = {};
  if (m?.server) entries.server = { path: norm(m.server), present: await fs.isFile(m.server) };
  if (m?.client) entries.client = { path: norm(m.client), present: await fs.isFile(m.client) };
  const hasBuildScript = await (async () => {
    const pkg = await fs.read("package.json", 512 * 1024);
    try {
      return !!(pkg && (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.build);
    } catch {
      return false;
    }
  })();
  for (const [side, e] of [["server", entries.server], ["client", entries.client]] as const) {
    if (!e || e.present) continue;
    warnings.push(
      `The ${side} entry ${e.path} is not in the repository at this commit${hasBuildScript ? " — it is build output (package.json has a build script) that the repository does not commit" : ""}. ` +
        `Install copies the tree as it is and never builds it, so ${side === "server" ? "the plugin will fail to start" : "its browser half will not load"} until ${e.path} exists.`,
    );
  }

  /* -- contributions -------------------------------------------------- */
  const c = m?.contributes;
  const caps = new Set<PluginCapability>(m?.capabilities ?? []);
  const contributions: PluginInspection["contributions"] = {
    modes: [],
    skills: [],
    instructions: [],
    personas: [],
    mcpServers: [],
    processes: [],
  };
  const contributionCode: string[] = [];
  const declaredSecrets = m?.secrets ?? [];
  if (c) {
    // The readers below are the host's own; each is pointed only at a
    // directory whose real path was checked to sit inside the plugin.
    const modesDir = c.modes ? await fs.dir(c.modes) : null;
    if (modesDir) contributions.modes = (await readModesDir(modesDir)).map((x) => x.name);
    const skillsDir = c.skills ? await fs.dir(c.skills) : null;
    if (skillsDir) contributions.skills = readSkillsDir(skillsDir).map((x) => x.name);
    const instrDir = c.instructions ? await fs.dir(c.instructions) : null;
    if (instrDir) contributions.instructions = (await readInstructionsDir(instrDir)).map((x) => x.name);
    const personasDir = c.personas ? await fs.dir(c.personas) : null;
    if (personasDir) contributions.personas = (await readInstructionsDir(personasDir)).map((x) => x.name);
    for (const [key, d] of [["modes", c.modes], ["skills", c.skills], ["instructions", c.instructions], ["personas", c.personas]] as const) {
      if (d && !(await fs.dir(d))) warnings.push(`contributes.${key}: ${norm(d)} is not a directory in the repository`);
    }

    if (c.mcpServers) {
      const text = await fs.read(c.mcpServers, MANIFEST_MAX_BYTES);
      if (text === null) warnings.push(`contributes.mcpServers: ${norm(c.mcpServers)} could not be read`);
      else {
        try {
          const parsed = PluginMcpServersFileSchema.safeParse(parseYaml(text) ?? {});
          if (!parsed.success) {
            warnings.push(`contributes.mcpServers: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
          } else {
            for (const s of parsed.data) {
              try {
                assertValidServerName(s.name);
              } catch (err) {
                warnings.push(`contributes.mcpServers: ${err instanceof Error ? err.message : String(err)}`);
              }
              const t = s.transport as Record<string, unknown> & { type: string };
              const args = Array.isArray(t.args) ? (t.args as string[]) : undefined;
              const env = (t.env ?? t.headers) as Record<string, string> | undefined;
              // Declared values, NOT expanded: the host expands `${VAR}` from its
              // own environment at load, and an inspection report is no place to
              // print the server's environment.
              contributions.mcpServers.push({
                name: s.name,
                transport: t.type,
                ...(typeof t.command === "string" ? { command: t.command } : {}),
                ...(args ? { args } : {}),
                ...(typeof t.url === "string" ? { url: t.url } : {}),
                ...(env ? { env: Object.keys(env) } : {}),
              });
              if (t.type === "stdio") contributionCode.push(...codePathsIn(t.command as string | undefined, args));
              const strings = [t.command, t.url, t.cwd, ...(args ?? []), ...Object.values(env ?? {})].filter((v): v is string => typeof v === "string");
              const undeclared = [...new Set(strings.flatMap((v) => referencedSecrets(v)))].filter((n) => !declaredSecrets.includes(n));
              if (undeclared.length) {
                warnings.push(`MCP server "${s.name}" references secret(s) not listed under secrets: ${undeclared.join(", ")} — they would expand to an empty string`);
              }
            }
          }
        } catch (err) {
          warnings.push(`contributes.mcpServers: not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (c.processes) {
      const text = await fs.read(c.processes, MANIFEST_MAX_BYTES);
      if (text === null) warnings.push(`contributes.processes: ${norm(c.processes)} could not be read`);
      else {
        try {
          const parsed = PluginProcessesFileSchema.safeParse(parseYaml(text) ?? {});
          if (!parsed.success) {
            warnings.push(`contributes.processes: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
          } else {
            for (const p of parsed.data) {
              contributions.processes.push({
                id: p.id,
                ...(p.name ? { name: p.name } : {}),
                command: p.command,
                ...(p.args?.length ? { args: p.args } : {}),
                ...(p.ports?.length ? { ports: p.ports } : {}),
                ...(p.url ? { url: p.url } : {}),
                autostart: !!p.autostart,
                singleton: !!p.singleton,
              });
              const cwd = p.cwd ? norm(p.cwd) : "";
              contributionCode.push(...codePathsIn(p.command, p.args).map((f) => (cwd ? `${cwd}/${norm(f)}` : f)));
            }
          }
        } catch (err) {
          warnings.push(`contributes.processes: not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  const oauth: PluginInspection["oauth"] = Object.entries(m?.oauth?.clients ?? {}).map(([name, cl]) => {
    let provider = cl.authorizationUrl;
    try {
      provider = new URL(cl.authorizationUrl).host;
    } catch {
      /* the schema already required a URL */
    }
    return { name, provider, scopes: cl.scopes ?? [] };
  });

  let settingsSchema: unknown;
  if (m?.settings) {
    const text = await fs.read(m.settings, MANIFEST_MAX_BYTES);
    try {
      if (text === null) throw new Error("missing or unreadable");
      settingsSchema = JSON.parse(text);
    } catch (err) {
      warnings.push(`settings schema ${norm(m.settings)} could not be read (${err instanceof Error ? err.message : String(err)}) — the plugin would get no settings form`);
    }
  }

  /* -- scan ----------------------------------------------------------- */
  const all = await fs.walk(5000);
  const targets = scanTargets(all, m, contributionCode).slice(0, SCAN_LIMITS.maxFiles);
  const scanned: Array<{ path: string; text: string }> = [];
  let total = 0;
  for (const f of targets) {
    const text = await fs.read(f, SCAN_LIMITS.maxFileBytes);
    if (text === null) {
      warnings.push(`${f} was not scanned (over ${SCAN_LIMITS.maxFileBytes} bytes)`);
      continue;
    }
    total += text.length;
    if (total > SCAN_LIMITS.maxTotalBytes) {
      warnings.push(`the scan stopped at ${SCAN_LIMITS.maxTotalBytes} bytes of source; later files were not read`);
      break;
    }
    scanned.push({ path: f, text });
  }
  const hooks = scanFiles(scanned);

  // A built server module runs from a directory with no node_modules; a
  // client bundle runs in a browser with no import map. A bare import in
  // either is a plugin that will not load, whatever its manifest says.
  for (const [side, e] of [["server", entries.server], ["client", entries.client]] as const) {
    if (!e?.present) continue;
    const text = scanned.find((f) => f.path === e.path)?.text;
    const bare = text ? runtimeNpmImports(text) : [];
    if (bare.length) {
      warnings.push(
        `${e.path} imports ${bare.slice(0, 5).join(", ")} at runtime — ` +
          (side === "server"
            ? "a plugin directory has no node_modules, so the server half would fail to load"
            : "the browser has no import map for them, so the client half would fail to load (react and friends must come from the host)"),
      );
    }
  }

  /* -- declared vs used ----------------------------------------------- */
  const reasons = new Map<PluginCapability, string[]>();
  const use = (cap: PluginCapability, why: string) => {
    const list = reasons.get(cap) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(cap, list);
  };
  for (const h of hooks) if (h.capability) use(h.capability, h.label);
  if (m?.client) use("ui", `client entry ${norm(m.client)}`);
  if (c?.mcpServers) use("mcp", "contributes.mcpServers (ignored without it)");
  if (c?.processes) use("process", "contributes.processes (ignored without it)");
  if (Object.keys(m?.oauth?.clients ?? {}).length) use("oauth", "oauth.clients (ignored without it)");
  // `const { chats } = ctx` hides which half is used; count it as both so
  // neither is reported unused on a guess.
  const destructuredChats = hooks.some((h) => /^(chats|attention) \(destructured/.test(h.label));

  const clientDir = m?.client ? manifestPathDir(m.client) : undefined;
  const serverCodeScanned = scanned.some((f) => !clientDir || !f.path.startsWith(`${clientDir}/`));
  const CODE_CAPS: PluginCapability[] = ["events", "routes", "chats:read", "chats:write", "memory", "secrets", "kv"];
  const usedOf = (cap: PluginCapability): boolean | null => {
    if (reasons.has(cap)) return true;
    if (destructuredChats && (cap === "chats:read" || cap === "chats:write")) return true;
    if (cap === "ui") return !!m?.client;
    if (cap === "mcp") return false;
    if (cap === "process" || cap === "oauth" || CODE_CAPS.includes(cap)) {
      if (!m?.server) return false;
      return serverCodeScanned ? false : null;
    }
    return null;
  };
  const declared = [...caps];
  const capabilities = declared
    .sort((a, b) => PLUGIN_CAPABILITIES.indexOf(a) - PLUGIN_CAPABILITIES.indexOf(b))
    .map((name) => ({ name, line: PLUGIN_CAPABILITY_LINES[name], used: usedOf(name) }));
  const undeclared = [...reasons.entries()]
    .filter(([cap]) => !caps.has(cap))
    .sort(([a], [b]) => PLUGIN_CAPABILITIES.indexOf(a) - PLUGIN_CAPABILITIES.indexOf(b))
    .map(([capability, because]) => ({ capability, because: because.slice(0, 5) }));
  const unused = capabilities.filter((x) => x.used === false).map((x) => x.name);

  // `ctx.secrets.get("X")` for an X the manifest does not list returns
  // undefined at runtime — the plugin will look broken, not refused.
  const literalSecrets = hooks
    .map((h) => /^secrets\.get\("([^"]+)"\)$/.exec(h.label)?.[1])
    .filter((n): n is string => !!n && !declaredSecrets.includes(n));
  if (literalSecrets.length) {
    warnings.push(`The code reads secret(s) not listed under secrets: ${literalSecrets.join(", ")} — ctx.secrets.get would return undefined for them`);
  }
  if (opts.fetched.skipped.length) {
    warnings.push(
      `${opts.fetched.skipped.length} entr${opts.fetched.skipped.length === 1 ? "y was" : "ies were"} not fetched: ${opts.fetched.skipped.slice(0, 5).join(", ")}${opts.fetched.skipped.length > 5 ? ", …" : ""}`,
    );
  }

  /* -- readme --------------------------------------------------------- */
  let readme: PluginInspection["readme"];
  const readmeFile = all.find((f) => /^readme(?:\.(?:md|markdown|txt))?$/i.test(f));
  if (readmeFile) {
    const text = await fs.read(readmeFile, 512 * 1024);
    const excerpt = text ? readmeExcerpt(text) : "";
    if (excerpt) readme = { file: readmeFile, excerpt };
  }

  /* -- installed ------------------------------------------------------ */
  let installed: PluginInspection["installed"];
  // Only a VALID manifest's id: an invalid one is unvalidated remote input,
  // and the lookup turns it into a path (`PluginInspector.installed` checks
  // the pattern again at that site).
  if (m && opts.installed) {
    const found = await opts.installed(m.id);
    if (found) {
      const version = m?.version ?? str(doc.version);
      const cmp = found.version && version ? compareVersions(version, found.version) : null;
      installed = {
        ...(found.version ? { version: found.version } : {}),
        ...(found.status ? { status: found.status } : {}),
        ...(found.needsRestart ? { needsRestart: true } : {}),
        ...(found.linked ? { linked: true } : {}),
        comparison: cmp === null ? "unknown" : cmp === 0 ? "same" : cmp > 0 ? "newer" : "older",
      };
      if (found.linked) {
        warnings.push(`"${m.id}" is installed as a link to a working directory (dispatch plugin link); installing replaces the link with a copy — the directory it points at is left alone`);
      }
    }
  }

  const refusal = !valid
    ? "the manifest is invalid"
    : !compatible
      ? `built for plugin API ${JSON.stringify(range)}; this Dispatch is ${PLUGIN_API_VERSION}`
      : undefined;

  return {
    source: opts.source,
    fetched: opts.fetched,
    valid,
    errors,
    installable: !refusal,
    ...(refusal ? { refusal } : {}),
    ...(id ? { id } : {}),
    ...(m?.name ?? str(doc.name) ? { name: m?.name ?? str(doc.name) } : {}),
    ...(m?.version ?? str(doc.version) ? { version: m?.version ?? str(doc.version) } : {}),
    ...(m?.description ?? str(doc.description) ? { description: m?.description ?? str(doc.description) } : {}),
    ...(readme ? { readme } : {}),
    compatibility: { ...(range ? { range } : {}), hostApi: PLUGIN_API_VERSION, compatible },
    entries,
    capabilities,
    contributions,
    secrets: declaredSecrets,
    oauth,
    ...(settingsSchema !== undefined ? { settingsSchema } : {}),
    scan: { files: scanned.map((f) => f.path), note: SCAN_NOTE },
    hooks,
    mismatches: { undeclared, unused },
    warnings,
    ...(installed ? { installed } : {}),
  };
}
