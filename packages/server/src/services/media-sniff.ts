/**
 * What a byte buffer ACTUALLY is, and how big the picture in it is.
 *
 * WHY THIS EXISTS: an agent's declared media type is routinely wrong or absent.
 * An MCP returns `application/octet-stream` for a screenshot, a `resource`
 * block omits `mimeType` entirely, a server writes `capture.bin`. Every one of
 * those was stored with a `.bin` extension and served back as
 * `application/octet-stream`, at which point the browser refuses to paint it
 * and the human sees the broken-image glyph — the exact failure this module
 * exists to end. The bytes always knew what they were; nothing was asking.
 *
 * So: sniff the container, and prefer the sniffed answer over the declared one
 * when they disagree. Dimensions come out of the same headers, which is worth
 * the extra parsing — a thumbnail that knows its aspect ratio reserves the
 * right space instead of making the transcript jump as bytes land.
 *
 * Header-only, no decoding: every reader below looks at a bounded prefix, so
 * this is cheap enough to run on every asset at ingest.
 */

/** A sniffed identification: what it is, and how big if that was knowable. */
export interface SniffedMedia {
  mimeType: string;
  width?: number;
  height?: number;
}

const ascii = (buf: Buffer, start: number, len: number): string =>
  buf.length >= start + len ? buf.toString("latin1", start, start + len) : "";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** SOF markers that carry a frame header. 0xC4/0xC8/0xCC are NOT frames. */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * The media type these bytes really are, or undefined when nothing matches.
 *
 * Undefined is meaningful: it means "no opinion", so the caller keeps whatever
 * the sender declared rather than overwriting a correct-but-exotic type (say
 * `image/jxl`) with a guess.
 */
export function sniffMediaType(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;

  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a") return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return "image/x-icon";
  }
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) {
    return "image/tiff";
  }
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) {
    return "image/tiff";
  }
  if (ascii(buf, 0, 5) === "%PDF-") return "application/pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "application/zip";
  }
  // Matroska and WebM share one magic; only the DocType inside distinguishes
  // them. `video/webm` is the safe label — a browser plays what it can decode
  // and a genuine .mkv would not have played under any other label either.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "video/webm";
  }

  // RIFF containers: the real type is the SECOND fourcc, not the first.
  if (ascii(buf, 0, 4) === "RIFF") {
    const form = ascii(buf, 8, 4);
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
    if (form === "AVI ") return "video/x-msvideo";
  }

  // ISO-BMFF: `....ftyp<brand>`. Still images (AVIF/HEIC) and video (MP4/MOV)
  // share the container, so the brand is the only thing telling them apart.
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }

  if (ascii(buf, 0, 4) === "OggS") {
    // Theora is the only video codec worth expecting here; anything else in an
    // Ogg stream is audio. The codec name appears in the first page.
    return buf.subarray(0, 128).includes("theora") ? "video/ogg" : "audio/ogg";
  }
  if (ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  // MPEG audio frame sync: eleven set bits.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";

  // SVG is text, so it has no magic — but it IS an image, and getting it wrong
  // means a generated diagram renders as a download chip instead of a picture.
  // Worth the sniff: projects that emit SVG emit nothing but SVG.
  if (looksLikeSvg(buf)) return "image/svg+xml";

  return undefined;
}

/**
 * A bounded look for an `<svg>` root, past any BOM, XML prolog, doctype or
 * leading comment. Deliberately anchored: an HTML page that merely CONTAINS an
 * inline `<svg>` somewhere is not an SVG file, and labelling it one would make
 * the browser refuse to render a document it would otherwise have shown.
 */
function looksLikeSvg(buf: Buffer): boolean {
  let head = buf.subarray(0, 2048).toString("utf8");
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  head = head.trimStart();
  if (head.startsWith("<svg")) return true;
  if (!head.startsWith("<")) return false;
  // Only prologue-ish nodes may precede the root: `<?xml …?>`, `<!DOCTYPE …>`,
  // `<!-- … -->`. Anything else (e.g. `<html>`) means this is not an SVG.
  let rest = head;
  for (let guard = 0; guard < 8; guard += 1) {
    rest = rest.trimStart();
    if (rest.startsWith("<svg")) return true;
    // Each prologue node is (opener, terminator). An UNTERMINATED node ends the
    // walk: `indexOf` returning -1 must not be turned into an offset, which is
    // what `indexOf(…) + 2` did — it yielded 1, cleared a `> 0` guard, and
    // walked one byte into content it had no business reading.
    const node = rest.startsWith("<?")
      ? ({ open: "<?", close: "?>" } as const)
      : rest.startsWith("<!--")
        ? ({ open: "<!--", close: "-->" } as const)
        : /^<!DOCTYPE/i.test(rest)
          ? ({ open: "<!DOCTYPE", close: ">" } as const)
          : null;
    if (!node) return false;
    const at = rest.indexOf(node.close, node.open.length);
    if (at < 0) return false;
    rest = rest.slice(at + node.close.length);
  }
  return false;
}

/**
 * Intrinsic pixel dimensions, or undefined when the format isn't one we parse
 * (or the header is truncated). Never throws — a malformed file costs a
 * caption, not the ingest.
 */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  try {
    const size = readSize(buf);
    // A zero or absurd dimension is a misparse, not a picture. `ImageRefSchema`
    // requires a positive int, so passing one on would fail the whole ref.
    if (!size) return undefined;
    const ok = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 1_000_000;
    return ok(size.width) && ok(size.height) ? size : undefined;
  } catch {
    // Truncated or malformed header. The bytes still store and still render;
    // only the dimension caption is lost.
    return undefined;
  }
}

function readSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    // IHDR is required to be the first chunk, so the size sits at a fixed
    // offset and no chunk walk is needed.
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a")) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    // BITMAPINFOHEADER height is SIGNED — negative means a top-down bitmap,
    // which is still that many rows tall.
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return jpegSize(buf);
  }
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return webpSize(buf);
  if (looksLikeSvg(buf)) return svgSize(buf);
  return undefined;
}

/**
 * Walk JPEG segments to the frame header. The dimensions are NOT at a fixed
 * offset: an arbitrary run of EXIF, ICC and comment segments precedes them, and
 * a progressive JPEG's frame marker differs from a baseline one's.
 */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      // A fill byte or a desync. Step one and look for the next marker rather
      // than giving up — padding between segments is legal.
      off += 1;
      continue;
    }
    const marker = buf[off + 1];
    // Standalone markers carry no length field, so they can't be skipped by one.
    if (marker === 0xff || marker === 0xd8 || marker === 0x01) {
      off += 1 + (marker === 0xff ? 0 : 1);
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      off += 2;
      continue;
    }
    // Start of scan: entropy-coded data begins and no frame header follows.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const size = buf.readUInt16BE(off + 2);
    if (size < 2) return undefined;
    if (JPEG_SOF.has(marker)) {
      // Frame header: precision(1), height(2), width(2) — height comes FIRST.
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + size;
  }
  return undefined;
}

/** WebP stores its size three different ways depending on the coding mode. */
function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  const chunk = ascii(buf, 12, 4);
  if (chunk === "VP8X" && buf.length >= 30) {
    // Extended format: canvas size as two 24-bit little-endian minus-ones.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    // Lossless: 14 bits of width then 14 of height, packed after the signature.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    // Lossy: verify the keyframe sync code before trusting the two shorts, or a
    // non-keyframe stream yields garbage dimensions.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return undefined;
}

/**
 * SVG dimensions from `width`/`height`, falling back to the `viewBox`.
 *
 * Only pixel-ish units are honoured: a width of `100%` describes the CONTAINER,
 * not the image, and reporting it as 100px would be worse than reporting
 * nothing. A percentage-sized SVG is exactly the common case where the viewBox
 * is the only real answer, which is why the fallback matters.
 */
function svgSize(buf: Buffer): { width: number; height: number } | undefined {
  const head = buf.subarray(0, 8192).toString("utf8");
  const tag = /<svg[^>]*>/i.exec(head)?.[0];
  if (!tag) return undefined;
  const attr = (name: string): number | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, "i").exec(tag);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  };
  const width = attr("width");
  const height = attr("height");
  if (width && height) return { width, height };

  const vb = /\bviewBox\s*=\s*["']\s*([^"']+?)\s*["']/i.exec(tag)?.[1];
  if (!vb) return undefined;
  const parts = vb.split(/[,\s]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [, , w, h] = parts;
  return w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : undefined;
}

/**
 * Reconcile a declared media type with what the bytes say, picking up
 * dimensions on the way through.
 *
 * The sniffed type WINS on disagreement. That is deliberate: the declaration is
 * the thing that has been observed to be wrong, and a browser handed a
 * `content-type` that contradicts the payload paints nothing at all.
 * The declaration survives only where sniffing has no opinion.
 */
export function identifyMedia(buf: Buffer, declared?: string): SniffedMedia {
  const sniffed = sniffMediaType(buf);
  const usable = declared && declared !== "application/octet-stream" ? declared : undefined;
  return {
    mimeType: sniffed ?? usable ?? "application/octet-stream",
    ...(imageSize(buf) ?? {}),
  };
}
