/**
 * A minimal, CONFINED tar reader for plugin inspection.
 *
 * Why not the system `tar` the CLI uses for `dispatch plugin add x.tgz`: that one is
 * fed a file the owner already chose to install. Here the bytes are a stranger's,
 * and `tar -x` will happily create symlinks, write through them, honour
 * absolute names on some builds, and has no file-count or byte cap. Doing it in
 * process lets every rule be checked BEFORE a byte reaches the disk:
 *
 *   - only regular files and directories are written; symlinks, hard links,
 *     devices and FIFOs are skipped and reported (a link is how an archive
 *     makes a later read escape the scratch directory);
 *   - every name is checked segment by segment — no absolute paths, no `..`,
 *     no backslashes, no `:` (an NTFS alternate data stream), no Windows device
 *     names — and the resolved target must sit inside the destination;
 *   - file count, total bytes and per-file bytes are capped on what is KEPT;
 *     entries outside the requested subdirectory are streamed past without
 *     being buffered, so a large monorepo costs bandwidth, not memory;
 *   - `node_modules/` and `.git/` are never written — the install copy drops
 *     them anyway, and a committed `node_modules` would blow every cap.
 *
 * Understands ustar, pax extended headers (`x`: long `path`; `g`: GitHub's
 * global header, whose `comment` is the commit sha) and GNU long names (`L`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { PluginInspectError } from "./url.js";

export interface TarCaps {
  /** Files written. */
  maxFiles: number;
  /** Bytes written, summed. */
  maxBytes: number;
  /** One file. */
  maxFileBytes: number;
}

export interface TarExtractOptions {
  /** Destination directory (created). */
  dest: string;
  /** Leading path components to drop — 1 for GitHub's `<owner>-<repo>-<sha>/` wrapper. */
  strip: number;
  /**
   * Only entries under this repository-relative directory are written, re-rooted
   * at `dest`; `""` takes everything. Entries outside it are read past, not kept.
   */
  subdir: string;
  /**
   * Narrow further to these directories (relative to `subdir`, `""` = all of
   * it) — a collection's plugins, without the rest of a monorepo around them.
   */
  include?: string[];
  /**
   * Don't throw when a cap is crossed: stop WRITING, note why in `overflow`,
   * and keep reading so `manifestDirs` is still complete. Collection discovery
   * needs this — a big monorepo blows the caps long before its last
   * `plugin.yaml` streams past, and the caller re-extracts only the plugins.
   * Manifests (`plugin.yaml`, the collection file) are written regardless,
   * bounded by {@link MAX_MARKER_BYTES} each.
   */
  soft?: boolean;
  caps: TarCaps;
}

export interface TarExtractResult {
  files: number;
  bytes: number;
  /** Entries refused, `path (reason)`. */
  skipped: string[];
  /** Repository-relative directories that hold a `plugin.yaml` (for "did you mean…"). */
  manifestDirs: string[];
  /** The pax global `comment` — GitHub writes the commit sha there. */
  globalComment?: string;
  /** `soft` mode: the first cap crossed. What was written is incomplete. */
  overflow?: string;
}

const BLOCK = 512;
/** pax / GNU long-name bodies are a few hundred bytes; anything near this is an attack, not a name. */
const MAX_META_BYTES = 1024 * 1024;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** A manifest kept past an overflow is YAML for a human to read; anything bigger is not one. */
const MAX_MARKER_BYTES = 256 * 1024;
const MAX_MARKERS = 64;
const COLLECTION_FILE = "dispatch-plugins.yaml";

/** Why `name` is unsafe to write, or null when it is fine. */
export function unsafeEntryName(name: string): string | null {
  if (!name) return "empty name";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "absolute path";
  if (name.includes("\\")) return "backslash in name";
  for (const seg of name.split("/")) {
    if (seg === "") continue;
    if (seg === "." || seg === "..") return "dot segment";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f:*?"<>|]/.test(seg)) return "reserved character";
    if (WINDOWS_DEVICE.test(seg)) return "Windows device name";
    if (/[. ]$/.test(seg)) return "trailing dot or space";
  }
  return null;
}

function cstring(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number): number {
  // Base-256 (high bit set) is how tar writes sizes over 8 GiB — far past any
  // cap here, so it is a refusal rather than something to decode.
  if (buf[start]! & 0x80) throw new PluginInspectError("archive entry is too large", 413);
  const s = cstring(buf, start, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  if (!Number.isFinite(n) || n < 0) throw new PluginInspectError("corrupt archive header", 502);
  return n;
}

/** pax records: `<len> <key>=<value>\n`, repeated. */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.subarray(i, sp).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** What to do with the body of the entry whose header was just read. */
type Pending =
  | { kind: "meta"; type: string; size: number; padded: number }
  | { kind: "file"; inner: string; target: string; size: number; padded: number }
  | { kind: "skip"; remaining: number };

/**
 * Read a tar stream and write the confined subset to `dest`. Throws
 * {@link PluginInspectError} (413) the moment a cap is crossed — the caller
 * deletes the scratch directory, so a partial extraction never survives.
 */
export async function extractTar(input: AsyncIterable<Buffer | Uint8Array>, opts: TarExtractOptions): Promise<TarExtractResult> {
  const destRoot = resolve(opts.dest);
  await mkdir(destRoot, { recursive: true });
  const subdir = opts.subdir.replace(/^\/+|\/+$/g, "");
  const include = opts.include?.map((p) => p.replace(/^\/+|\/+$/g, ""));
  let markers = 0;
  const result: TarExtractResult = { files: 0, bytes: 0, skipped: [], manifestDirs: [] };

  let buf: Buffer = Buffer.alloc(0);
  let pending: Pending | null = null;
  let paxNext: Record<string, string> = {};
  let longName: string | undefined;
  let ended = false;

  /** Header → what to do with its body. Name rules and caps run HERE, before any body byte is buffered. */
  const onHeader = async (header: Buffer): Promise<Pending | null> => {
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > MAX_META_BYTES) throw new PluginInspectError("archive metadata header is implausibly large", 502);
      return { kind: "meta", type, size, padded };
    }
    let name = cstring(header, 0, 100);
    if (cstring(header, 257, 6).startsWith("ustar")) {
      const prefix = cstring(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName) name = longName;
    if (paxNext.path) name = paxNext.path;
    paxNext = {};
    longName = undefined;
    const skip = (): Pending => ({ kind: "skip", remaining: padded });

    const rel = name.split("/").filter(Boolean).slice(opts.strip).join("/");
    if (!rel) return skip();
    if ((rel === "plugin.yaml" || rel.endsWith("/plugin.yaml")) && result.manifestDirs.length < 200) {
      result.manifestDirs.push(rel === "plugin.yaml" ? "" : rel.slice(0, -"/plugin.yaml".length));
    }
    let inner: string;
    if (!subdir) inner = rel;
    else if (rel.startsWith(`${subdir}/`)) inner = rel.slice(subdir.length + 1);
    else return skip();
    if (inner.split("/").some((s) => SKIP_DIRS.has(s))) return skip();
    const marker = inner === COLLECTION_FILE || inner === "plugin.yaml" || inner.endsWith("/plugin.yaml");
    if (include && !marker && !include.some((p) => p === "" || inner === p || inner.startsWith(`${p}/`))) return skip();

    const isFile = type === "0" || type === "7";
    const isDir = type === "5";
    if (!isFile && !isDir) {
      const why = type === "2" ? "symlink" : type === "1" ? "hard link" : `entry type ${JSON.stringify(type)}`;
      result.skipped.push(`${inner} (${why})`);
      return skip();
    }
    const unsafe = unsafeEntryName(inner);
    if (unsafe) {
      result.skipped.push(`${inner} (${unsafe})`);
      return skip();
    }
    const target = resolve(destRoot, inner);
    // Lexical confinement after the name rules — belt and braces, since the
    // rules above already exclude every way out that `resolve` would honour.
    if (target === destRoot || !target.startsWith(destRoot + sep)) {
      result.skipped.push(`${inner} (outside the plugin directory)`);
      return skip();
    }
    if (isDir) {
      await mkdir(target, { recursive: true });
      return skip();
    }
    if (result.overflow) {
      // Past a soft cap only manifests are still worth having — they are what
      // says which directories to fetch again, strictly, on the second pass.
      if (!marker || size > MAX_MARKER_BYTES || markers >= MAX_MARKERS) return skip();
      markers += 1;
      return { kind: "file", inner, target, size, padded };
    }
    const over = (message: string): Pending => {
      if (!opts.soft) throw new PluginInspectError(message, 413);
      result.overflow = message;
      if (!marker || size > MAX_MARKER_BYTES) return skip();
      markers += 1;
      return { kind: "file", inner, target, size, padded };
    };
    if (size > opts.caps.maxFileBytes) {
      return over(`${inner} is ${size} bytes — over the ${opts.caps.maxFileBytes}-byte per-file limit`);
    }
    if (result.files + 1 > opts.caps.maxFiles) {
      return over(`the plugin directory has more than ${opts.caps.maxFiles} files`);
    }
    if (result.bytes + size > opts.caps.maxBytes) {
      return over(`the plugin directory is larger than ${opts.caps.maxBytes} bytes`);
    }
    result.files += 1;
    result.bytes += size;
    if (marker) markers += 1;
    return { kind: "file", inner, target, size, padded };
  };

  const onBody = async (p: Extract<Pending, { kind: "meta" | "file" }>, data: Buffer) => {
    if (p.kind === "meta") {
      if (p.type === "x") paxNext = { ...paxNext, ...paxRecords(data) };
      else if (p.type === "g") {
        const g = paxRecords(data);
        if (g.comment) result.globalComment = g.comment.trim();
      } else if (p.type === "L") longName = cstring(data, 0, data.length);
      return;
    }
    await mkdir(dirname(p.target), { recursive: true });
    // `wx`: never overwrite — a second entry with the same name is an archive
    // trying to replace something already checked.
    await writeFile(p.target, data, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") result.skipped.push(`${p.inner} (duplicate entry)`);
      else throw err;
    });
  };

  for await (const chunk of input) {
    if (ended) continue;
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    for (;;) {
      if (pending?.kind === "skip") {
        const n = Math.min(pending.remaining, buf.length);
        buf = buf.subarray(n);
        pending.remaining -= n;
        if (pending.remaining > 0) break;
        pending = null;
        continue;
      }
      if (pending) {
        if (buf.length < pending.padded) break;
        const p: Extract<Pending, { kind: "meta" | "file" }> = pending;
        pending = null;
        await onBody(p, Buffer.from(buf.subarray(0, p.size)));
        buf = buf.subarray(p.padded);
        continue;
      }
      if (buf.length < BLOCK) break;
      const header = Buffer.from(buf.subarray(0, BLOCK));
      buf = buf.subarray(BLOCK);
      if (header.every((b) => b === 0)) {
        ended = true;
        break;
      }
      pending = await onHeader(header);
    }
  }
  if (pending && !(pending.kind === "skip" && pending.remaining === 0)) {
    throw new PluginInspectError("the archive ended in the middle of an entry", 502);
  }
  return result;
}
