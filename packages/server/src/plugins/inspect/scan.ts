/**
 * The "Hooks used" scan: what a plugin's SOURCE TEXT says it touches.
 *
 * A token scan over comment-stripped source, never an evaluation. It finds
 * `ctx.*` / `host.*` member use (and the name `activate`'s first parameter
 * actually has, so `activate(context)` and a bundler's `activate(e)` are both
 * followed), destructuring of those members, and the usual ways out of the
 * process — `fetch`, `node:http`, `node:child_process`, `node:fs`, `eval`.
 *
 * What it cannot see, and the report says so: a member reached through an
 * alias it does not follow (`const c = ctx; c.kv`), a name built at runtime
 * (`ctx[name]`), code fetched or `import()`ed from a computed specifier. The
 * last is reported as a hook of its own, because it is exactly the thing a
 * static report cannot vouch for.
 */
import type { PluginCapability, PluginHook } from "@dispatch/shared";

export const SCAN_NOTE =
  "A static scan of the source text. It follows ctx./host. and activate()'s parameter, " +
  "but code can reach the same APIs through aliases, computed names or code loaded at runtime, which it cannot see.";

/** One raw finding before de-duplication. */
interface Hit {
  kind: PluginHook["kind"];
  label: string;
  capability?: PluginCapability;
  index: number;
}

/**
 * Blank out comments, keeping strings and every newline so offsets and line
 * numbers survive. Regex literals are not recognised — a `/` is a division
 * unless `//` or `/*` follows — so a regex containing a quote can desync a
 * string; single- and double-quoted strings end at a newline, which bounds the
 * damage to one line.
 */
export function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (c !== "`" && src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 1-based line of `index`. */
function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const esc = (s: string) => s.replace(/[$]/g, "\\$");
/**
 * A string literal whose quote is capture group `q` and whose content is group
 * `q + 1` — numbered by the caller, because a backreference is absolute and
 * the literal sits after a different number of groups in each pattern.
 */
const str = (q: number) => "([\"'`])([^\"'`\\n]{0,200})\\" + q;
/** Member access tolerant of `!` / `?.` / whitespace: `ctx!.kv`, `ctx?.kv`, `ctx .kv`. */
const DOT = String.raw`\s*[!?]?\s*\.\s*`;

/** Server `ctx` members → capability, with the methods that pick a finer one. */
const SERVER_MEMBERS: Record<string, { capability?: PluginCapability; methods?: Record<string, PluginCapability | undefined> }> = {
  bus: { capability: "events" },
  routes: { capability: "routes" },
  chats: {
    methods: {
      list: "chats:read",
      find: "chats:read",
      read: "chats:read",
      state: "chats:read",
      send: "chats:write",
      ask: "chats:write",
      reply: "chats:write",
    },
  },
  attention: { methods: { list: "chats:read", answer: "chats:write" } },
  memory: { capability: "memory" },
  secrets: { capability: "secrets" },
  kv: { capability: "kv" },
  processes: { capability: "process" },
  oauth: { capability: "oauth" },
  projects: {},
};

const CLIENT_SLOTS = ["composerControl", "settingsSection", "panelTab", "chatBadge"];

/** Node built-ins worth a line on the card, and what using one means. */
const IO_MODULES: Record<string, string> = {
  child_process: "child_process — can run programs on this machine",
  http: "http — makes or serves network connections",
  https: "https — makes network connections",
  http2: "http2 — makes network connections",
  net: "net — raw network sockets",
  tls: "tls — raw network sockets",
  dgram: "dgram — UDP sockets",
  dns: "dns — network lookups",
  fs: "fs — reads/writes files on this machine",
  "fs/promises": "fs — reads/writes files on this machine",
  worker_threads: "worker_threads — runs code in other threads",
  vm: "vm — compiles and runs code at runtime",
  cluster: "cluster — forks processes",
  module: "module — loads modules at runtime",
};

/** The names `activate`'s first parameter has in this file, plus the conventional ones. */
export function contextNames(text: string): string[] {
  const names = new Set(["ctx", "host", "context"]);
  const patterns = [
    /\bactivate\s*(?::\s*(?:async\s+)?function\s*\*?\s*)?\(\s*([A-Za-z_$][\w$]*)/g,
    /\bactivate\s*[:=]\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/g,
    /\bactivate\s*[:=]\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+activate\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]!);
  return [...names];
}

/**
 * The argument text of a call whose `(` was just consumed at `from`: up to the
 * matching `)`, bracket depth counted, capped at 4 KB. Strings are not
 * tracked — a bracket inside one can end the slice early, which only costs
 * the id on the label. Without the bound, a registration with no `id` (a chat
 * badge) borrowed the NEXT registration's.
 */
function callArgs(text: string, from: number): string {
  let depth = 1;
  const end = Math.min(text.length, from + 4096);
  for (let i = from; i < end; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(from, i);
    }
  }
  return text.slice(from, end);
}

/** `id: "voice"` in a registration's argument object. */
function literalId(args: string): string | undefined {
  return /\bid\s*:\s*(["'`])([^"'`\n]{1,80})\1/.exec(args)?.[2];
}

/** Scan one file's text. Returns raw hits with offsets; `scanFiles` dedupes. */
export function scanText(src: string): Array<Omit<Hit, "index"> & { line: number }> {
  const text = stripComments(src);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const hits: Hit[] = [];
  const add = (h: Hit) => hits.push(h);
  const A = `(?<![\\w$.])(?:${contextNames(text).map(esc).join("|")})`;

  /* -- server ctx ----------------------------------------------------- */
  for (const m of text.matchAll(new RegExp(`${A}${DOT}bus${DOT}on\\s*\\(\\s*(?:${str(1)})?`, "g"))) {
    add({ kind: "event", label: m[2] !== undefined ? `bus.on("${m[2]}")` : "bus.on(<computed>)", capability: "events", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}bus${DOT}subscribe\\b`, "g"))) {
    add({ kind: "event", label: "bus.subscribe — every event", capability: "events", index: m.index! });
  }
  // Routes: find the router parameter name(s), then its verb calls.
  const routers = new Set<string>();
  for (const m of text.matchAll(new RegExp(`${A}${DOT}routes\\s*[!?]?\\s*(?:\\?\\.\\s*)?\\(\\s*(?:async\\s*)?\\(?\\s*([A-Za-z_$][\\w$]*)?`, "g"))) {
    if (m[1]) routers.add(m[1]);
    add({ kind: "api", label: "routes(…) — registers HTTP routes", capability: "routes", index: m.index! });
  }
  if (routers.size) {
    const R = `(?<![\\w$.])(?:${[...routers].map(esc).join("|")})`;
    for (const m of text.matchAll(new RegExp(`${R}\\s*\\.\\s*(get|post|put|patch|delete|head|options|all)\\s*\\(\\s*${str(2)}`, "g"))) {
      add({ kind: "route", label: `${m[1]!.toUpperCase()} ${m[3]}`, capability: "routes", index: m.index! });
    }
  }
  for (const [member, spec] of Object.entries(SERVER_MEMBERS)) {
    if (member === "bus" || member === "routes") continue;
    // `(?:<…>)?` — a TypeScript type argument between name and call: `ctx.kv!.get<Stats>("stats")`.
    const re = new RegExp(`${A}${DOT}${member}${DOT}([A-Za-z_$][\\w$]*)\\s*(?:<[^<>()]{0,80}>)?\\s*\\(\\s*(?:${str(2)})?`, "g");
    for (const m of text.matchAll(re)) {
      const method = m[1]!;
      const capability = spec.methods ? spec.methods[method] : spec.capability;
      if (spec.methods && !(method in spec.methods)) continue;
      const arg = m[3] !== undefined && /^(secrets|processes|oauth)$/.test(member) ? `("${m[3]}")` : "";
      add({ kind: "api", label: `${member}.${method}${arg}`, capability, index: m.index! });
    }
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}emit\\s*\\(`, "g"))) {
    add({ kind: "event", label: "emit — sends plugin-events to the browser", index: m.index! });
  }

  /* -- client host ---------------------------------------------------- */
  for (const m of text.matchAll(new RegExp(`${A}${DOT}slots${DOT}(${CLIENT_SLOTS.join("|")})\\s*\\(`, "g"))) {
    const id = literalId(callArgs(text, m.index! + m[0].length));
    add({ kind: "slot", label: id ? `${m[1]} "${id}"` : m[1]!, capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}toast\\s*\\(`, "g"))) {
    add({ kind: "slot", label: "toast", capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}engines${DOT}(dictation|tts)${DOT}register\\s*\\(`, "g"))) {
    const id = literalId(callArgs(text, m.index! + m[0].length));
    add({ kind: "engine", label: `${m[1] === "tts" ? "TTS" : "dictation"} engine${id ? ` "${id}"` : ""}`, capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}chat${DOT}(setExt|send|setMode|current)\\s*\\(`, "g"))) {
    const label = m[1] === "setExt" ? "chat.ext — writes per-chat state" : m[1] === "send" ? "chat.send — sends into a chat from the browser" : `chat.${m[1]}`;
    add({ kind: "chat", label, capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(/[!?]?\.\s*ext\s*\??\.?\s*\[/g)) {
    add({ kind: "chat", label: "chat.ext — reads per-chat state", capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}events${DOT}(on|onPlugin)\\s*\\(\\s*(?:${str(2)})?`, "g"))) {
    const label = m[1] === "onPlugin" ? "events.onPlugin — its own plugin-events" : m[3] !== undefined ? `events.on("${m[3]}")` : "events.on(<computed>)";
    add({ kind: "event", label, capability: "ui", index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`${A}${DOT}api${DOT}fetch\\s*\\(\\s*(?:${str(1)})?`, "g"))) {
    add({ kind: "api", label: m[2] !== undefined ? `api.fetch("${m[2]}") — its own routes` : "api.fetch — its own routes", capability: "ui", index: m.index! });
  }

  /* -- destructuring: `const { kv, chats } = ctx` ------------------------ */
  for (const m of text.matchAll(new RegExp(`\\{([^{}]{1,300})\\}\\s*=\\s*${A}\\b(?!\\s*[!?]?\\.)`, "g"))) {
    for (const part of m[1]!.split(",")) {
      const key = part.split(":")[0]!.trim().replace(/\s*=.*$/, "");
      const spec = SERVER_MEMBERS[key];
      if (!spec) continue;
      add({ kind: "api", label: `${key} (destructured — calls not traced)`, capability: spec.capability, index: m.index! });
    }
  }

  /* -- I/O --------------------------------------------------------------- */
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])fetch\\s*\\(\\s*(?:${str(1)})?`, "g"))) {
    const url = m[2];
    const host = url && /^https?:\/\/([^/"'`\s$]+)/.exec(url)?.[1];
    add({ kind: "io", label: host ? `fetch → ${host}` : "fetch — outbound HTTP (URL not literal)", index: m.index! });
  }
  for (const m of text.matchAll(/\bnew\s+(WebSocket|EventSource)\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(/g)) {
    add({ kind: "io", label: `${m[1] ?? (m[0].includes("XML") ? "XMLHttpRequest" : "sendBeacon")} — network connection`, index: m.index! });
  }
  const modules = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(?:node:)?(${Object.keys(IO_MODULES).map((k) => k.replace("/", "\\/")).join("|")})\1`, "g");
  for (const m of text.matchAll(modules)) add({ kind: "io", label: IO_MODULES[m[2]!]!, index: m.index! });
  for (const m of text.matchAll(/(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(/g)) {
    add({ kind: "io", label: "eval / new Function — runs code built at runtime", index: m.index! });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*(["'`])(https?:[^"'`]*)\1/g)) {
    add({ kind: "io", label: `import(${m[2]}) — loads remote code`, index: m.index! });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*(?!["'`]|\s*\))/g)) {
    add({ kind: "io", label: "import(<computed>) — loads code chosen at runtime", index: m.index! });
  }
  for (const m of text.matchAll(/\bprocess\s*\.\s*env\b/g)) {
    add({ kind: "io", label: "process.env — reads environment variables", index: m.index! });
  }

  return hits.map(({ index, ...h }) => ({ ...h, line: lineAt(starts, index) }));
}

/** Bare npm specifiers a module imports at runtime (not `node:*`, not relative). */
export function runtimeNpmImports(src: string): string[] {
  const text = stripComments(src);
  const out = new Set<string>();
  const re = /(?:^|[;\n}])\s*import\s+(?!type\b)(?:[^'"`;]*?\s+from\s+)?(["'])([^"']+)\1|\brequire\s*\(\s*(["'])([^"']+)\3\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[2] ?? m[4]!;
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("file:") || spec.startsWith("data:")) continue;
    if (/^https?:/.test(spec)) continue;
    // A bare built-in (`fs`, `path`) resolves without node_modules.
    if (BUILTINS.has(spec.split("/")[0]!)) continue;
    out.add(spec);
  }
  return [...out];
}

const BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process", "querystring", "readline", "stream",
  "string_decoder", "timers", "tls", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

/**
 * Scan several files and fold the hits into one de-duplicated list: same kind
 * and label → one hook, located at its first sighting, with a count.
 */
export function scanFiles(files: Array<{ path: string; text: string }>): PluginHook[] {
  const byKey = new Map<string, PluginHook>();
  for (const f of files) {
    for (const h of scanText(f.text)) {
      const key = `${h.kind}\0${h.label}`;
      const prior = byKey.get(key);
      if (prior) prior.count += 1;
      else byKey.set(key, { kind: h.kind, label: h.label, ...(h.capability ? { capability: h.capability } : {}), file: f.path, line: h.line, count: 1 });
    }
  }
  const order: PluginHook["kind"][] = ["event", "route", "slot", "engine", "chat", "api", "io"];
  return [...byKey.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
}
