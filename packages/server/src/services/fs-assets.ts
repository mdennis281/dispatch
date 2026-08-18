/**
 * Serving a file from the PROJECT filesystem as a renderable asset.
 *
 * WHY THIS EXISTS: by far the most common way an agent "sends an image" is to
 * write one and mention where. It runs a script that emits `out/chart.png`,
 * then says `![chart](out/chart.png)` — or just names the path in prose. No
 * bytes cross the wire, no MCP block is involved, and nothing in the asset
 * pipeline ever hears about it. The markdown renderer emitted a bare
 * `<img src="out/chart.png">`, which resolves against the SPA's origin, 404s,
 * and paints the broken-image glyph. That is the "broken or just missed" the
 * whole compatibility layer exists to fix.
 *
 * So there has to be a way to read a file the agent wrote. That is real
 * authority, hence this module rather than a few lines in a route:
 *
 *   • CONFINEMENT. A path must resolve inside the chat's own worktree (or the
 *     project checkout, or the OS temp dir where tools stage captures).
 *     Resolution happens through `realpath` FIRST, so a symlink inside the
 *     worktree pointing at `~/.ssh/id_rsa` is rejected on where it LANDS, not
 *     on how it was spelled.
 *   • TYPE HONESTY. The type is sniffed from the bytes, never taken from the
 *     extension, and anything that doesn't sniff as media is refused outright.
 *     This endpoint exists to show pictures; it must not become a way to read
 *     `.env` through an `<img>` tag.
 *   • SIZE. Streamed, with range support, and capped — a preview must not be
 *     able to pull a 40 GB core dump through the server.
 */
import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { mediaKind } from "@dispatch/shared";
import { isPathWithinRoots } from "./mcp-assets.js";
import { sniffMediaType } from "./media-sniff.js";

/** Enough bytes for every signature `sniffMediaType` looks at, SVG included. */
const SNIFF_BYTES = 4096;

/**
 * Ceiling for a file served this way. Generous enough for a screen recording,
 * far below "the agent pointed at a disk image". Referenced MCP assets get the
 * same treatment at the same order of magnitude (`MAX_REFERENCED_ASSET_BYTES`).
 */
export const MAX_FS_ASSET_BYTES = 256 * 1024 * 1024;

/** Why a path could not be served. Distinct so the route can pick a status. */
export type FsAssetDenial = "not-found" | "forbidden" | "too-large" | "not-media";

export interface FsAssetHit {
  /** The realpath'd, confinement-checked absolute path. */
  path: string;
  size: number;
  /** Sniffed from the bytes — never inferred from the extension. */
  mimeType: string;
}

export type FsAssetResult = FsAssetHit | { denied: FsAssetDenial };

export function isDenied(r: FsAssetResult): r is { denied: FsAssetDenial } {
  return "denied" in r;
}

/**
 * Resolve `requested` against `roots` and confirm it is media we will serve.
 *
 * `roots[0]` doubles as the base for a relative path: an agent's `out/chart.png`
 * means "relative to where the agent runs", which is the chat's worktree.
 */
export async function resolveFsAsset(
  requested: string,
  roots: string[],
): Promise<FsAssetResult> {
  const wanted = requested.trim();
  if (!wanted || !roots.length) return { denied: "not-found" };
  // A NUL byte truncates the path at the syscall boundary, so `a.png\0../../x`
  // would pass a check made on the whole string and then open something else.
  if (wanted.includes("\0")) return { denied: "forbidden" };

  const abs = isAbsolute(wanted) ? wanted : resolvePath(roots[0], wanted);
  let real: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    // Follow symlinks BEFORE deciding: a link inside the worktree pointing out
    // of it would otherwise pass a check made on the pre-resolution path.
    real = await realpath(abs);
    info = await stat(real);
  } catch {
    return { denied: "not-found" };
  }
  if (!info.isFile()) return { denied: "not-found" };

  const allowed = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  if (!isPathWithinRoots(real, allowed)) return { denied: "forbidden" };
  if (info.size > MAX_FS_ASSET_BYTES) return { denied: "too-large" };

  const mimeType = await sniffFile(real);
  // Refuse anything that isn't media. Without this, `?path=.env` would stream a
  // secrets file to whoever could reach the endpoint — the extension is not
  // consulted precisely so that renaming it `.png` doesn't help either.
  if (!mimeType || mediaKind(mimeType) === "file") return { denied: "not-media" };

  return { path: real, size: info.size, mimeType };
}

/** Sniff a file's type from a bounded prefix, without reading the whole thing. */
async function sniffFile(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return undefined;
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return sniffMediaType(buf.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A read stream over the whole file, or the requested byte range. */
export function openFsAsset(
  path: string,
  range?: { start: number; end: number },
): NodeJS.ReadableStream {
  return createReadStream(path, range);
}
