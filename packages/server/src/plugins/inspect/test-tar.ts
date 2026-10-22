/**
 * Test-only: write a tar the way GitHub's codeload does — a pax global header
 * carrying the commit sha, then every entry under `<owner>-<repo>-<short>/` —
 * so the inspector's whole pipeline can run against fixtures read from disk,
 * with no network in CI.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  /** `0` file (default), `5` dir, `2` symlink, `1` hard link. */
  type?: "0" | "5" | "2" | "1";
  body?: Buffer | string;
  linkname?: string;
}

function header(name: string, size: number, type: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname.slice(0, 100), 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function pad(body: Buffer): Buffer {
  const rem = body.length % 512;
  return rem ? Buffer.concat([body, Buffer.alloc(512 - rem)]) : body;
}

function paxRecord(key: string, value: string): string {
  const base = ` ${key}=${value}\n`;
  let len = base.length + String(base.length).length;
  if (String(len).length !== String(len - 1).length) len += 1;
  return `${len}${base}`;
}

/** A tar of `entries`, optionally led by a pax global header with `comment=<sha>`. */
export function makeTar(entries: TarEntry[], opts: { comment?: string } = {}): Buffer {
  const parts: Buffer[] = [];
  if (opts.comment) {
    const body = Buffer.from(paxRecord("comment", opts.comment));
    parts.push(header("pax_global_header", body.length, "g"), pad(body));
  }
  for (const e of entries) {
    const type = e.type ?? "0";
    const body = Buffer.from(e.body ?? "");
    if (Buffer.byteLength(e.name) > 100) {
      const pax = Buffer.from(paxRecord("path", e.name));
      parts.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    parts.push(header(e.name, type === "0" ? body.length : 0, type, e.linkname));
    if (type === "0") parts.push(pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const gzip = (b: Buffer): Buffer => gzipSync(b);

/**
 * Every file under `dir` as tar entries at `<prefix>/…`, skipping what the
 * repository would not contain: `node_modules` and the build output a
 * directory's own `.gitignore` lists as `name/`.
 */
export async function entriesFromDir(dir: string, prefix: string): Promise<TarEntry[]> {
  const ignored = new Set<string>(["node_modules"]);
  try {
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    for (const line of gi.split(/\r?\n/)) {
      const m = /^([\w.-]+)\/$/.exec(line.trim());
      if (m) ignored.add(m[1]!);
    }
  } catch {
    /* no .gitignore */
  }
  const out: TarEntry[] = [];
  const walk = async (abs: string) => {
    for (const e of (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(abs, e.name);
      const rel = relative(dir, child).split(sep).join("/");
      if (ignored.has(rel.split("/")[0]!)) continue;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push({ name: `${prefix}/${rel}`, body: await readFile(child) });
    }
  };
  await walk(dir);
  return out;
}

/** A Readable-like async iterable over one buffer, in chunks — so the parser sees split headers. */
export async function* chunked(buf: Buffer, size = 777): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
