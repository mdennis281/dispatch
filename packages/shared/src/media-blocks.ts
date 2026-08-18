/**
 * Every way an agent might hand back a picture, recognized in one place.
 *
 * WHY THIS EXISTS: there is no single spelling for "here is an image". Each
 * provider, SDK and hand-rolled MCP server picked its own, and Dispatch sees
 * all of them in the same transcript:
 *
 *   Anthropic  {type:"image", source:{type:"base64", data, media_type}}
 *              {type:"image", source:{type:"url", url}}
 *   MCP        {type:"image", data, mimeType}                    (ImageContent)
 *              {type:"audio", data, mimeType}                    (AudioContent)
 *              {type:"resource", resource:{uri, mimeType, blob}} (binary embed)
 *              {type:"resource", resource:{uri, mimeType, text}} (SVG embed)
 *   OpenAI     {type:"image_url", image_url:{url}}
 *   Improvised {type:"image", url} / {image:"data:…"} / a bare data: URL in text
 *
 * Only the first two were understood. The rest were dropped on the floor or
 * stored as unrenderable junk, which is why images "sent by the agent" kept not
 * arriving. Adding a case here fixes it on BOTH sides at once: the server uses
 * this to persist bytes at ingest, and the client uses the identical function
 * to re-read transcripts written before the case existed. That is the whole
 * reason it lives in shared rather than in either one.
 *
 * PURE. Nothing here reads a file, decodes base64, or touches a network — it
 * only decides what a block IS, so every case is a table-driven unit test.
 */

/** An image/video/audio payload carried INLINE in a content block. */
export interface InlineMedia {
  /** Base64 payload, any data-URL prefix and whitespace already stripped. */
  base64?: string;
  /** A remote URL to render directly. Mutually exclusive with `base64`. */
  url?: string;
  /** Declared type. May be wrong — the server re-sniffs the bytes. */
  mimeType?: string;
  /** Caption, when the block named one. */
  alt?: string;
}

/** `data:<mime>;base64,<payload>` split into its parts. */
export interface ParsedDataUrl {
  mimeType?: string;
  base64: string;
}

/** The `data:<mime>[;param][;base64],` preamble, without the payload. */
const DATA_URL_HEAD = String.raw`data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+)?((?:;[a-z0-9-]+=[^;,]*)*)(;base64)?,`;

/**
 * A data URL EMBEDDED in a larger string — prose, markdown, a JSON field.
 *
 * The payload class excludes whitespace on purpose. Allowing `\s` (to tolerate
 * a payload wrapped across lines) made a single match run out of one data URL,
 * across the sentence between, and into the next one — two images became one
 * corrupt blob. Wrapped payloads are still handled, by the anchored form below;
 * this one only has to find where a URL STARTS in running text.
 */
const DATA_URL_RE = new RegExp(`${DATA_URL_HEAD}([A-Za-z0-9+/=%._~!$&*+-]+)`, "i");

/**
 * A string that IS a data URL, whitespace and all. Safe to be permissive here:
 * there is no following prose to run into, so a base64 payload broken across
 * lines (which plenty of encoders emit) survives intact.
 */
const DATA_URL_ANCHORED = new RegExp(`^\\s*${DATA_URL_HEAD}([\\s\\S]*)$`, "i");

/** Characters legal in base64 once whitespace is gone. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Split a data URL, or null if it isn't one.
 *
 * Percent-decodes a non-base64 payload (`data:image/svg+xml,<svg…>`) and
 * re-encodes it, so the caller only ever has to deal with base64. That spelling
 * is common for SVG specifically — it is the one image format small and textual
 * enough that tools inline it raw.
 */
export function parseDataUrl(input: string): ParsedDataUrl | null {
  // Anchored first: when the whole string is the URL, a payload wrapped across
  // lines must survive — and only the anchored form tolerates the newlines.
  const m = DATA_URL_ANCHORED.exec(input) ?? DATA_URL_RE.exec(input);
  if (!m) return null;
  const [, mimeType, , base64Flag, payload] = m;
  if (payload === undefined) return null;
  if (base64Flag) {
    const cleaned = stripBase64Whitespace(payload);
    return cleaned ? { mimeType, base64: cleaned } : null;
  }
  // Percent-encoded text payload. Re-encode so every consumer sees base64.
  try {
    const text = decodeURIComponent(payload);
    if (!text) return null;
    return { mimeType, base64: utf8ToBase64(text) };
  } catch {
    return null;
  }
}

/**
 * Whitespace-free base64, or "" if what's left isn't base64 at all.
 *
 * `Buffer.from(s, "base64")` NEVER throws — it silently skips characters it
 * doesn't recognize and returns whatever it managed to decode. So a payload
 * that still carries its `data:image/png;base64,` prefix decodes to plausible
 * garbage and gets written to disk as a corrupt file. Validating here is what
 * turns that silent corruption into a rejected block.
 */
export function stripBase64Whitespace(raw: string): string {
  const cleaned = raw.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0) {
    // Unpadded base64 is legal in plenty of encoders, so only reject when the
    // remainder can't be padded to a whole group (a length ≡ 1 mod 4 can't).
    const pad = cleaned.length % 4;
    if (!cleaned || pad === 1) return "";
    return BASE64_RE.test(cleaned) ? cleaned + "=".repeat(4 - pad) : "";
  }
  return BASE64_RE.test(cleaned) ? cleaned : "";
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 of a UTF-8 string.
 *
 * Hand-rolled rather than reaching for `Buffer` or `btoa`: this package is
 * isomorphic and typechecks with NO platform lib, so touching either global
 * would mean either a build break or a `declare` that lies about one runtime to
 * satisfy the other. The encoder is fifteen lines and correct everywhere.
 */
function utf8ToBase64(text: string): string {
  // Manual UTF-8 encoding, so this needs no TextEncoder either. Surrogate pairs
  // are handled by iterating CODE POINTS — `for…of` over a string does that,
  // where indexing would split an emoji into two invalid halves.
  const bytes: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
      cp = 0;
    }
  }

  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    const remaining = bytes.length - i;
    const at = (shift: number): string => B64_ALPHABET.charAt((n >> shift) & 63);
    out += at(18) + at(12);
    out += remaining > 1 ? at(6) : "=";
    out += remaining > 2 ? at(0) : "=";
  }
  return out;
}

/** A remote URL we are willing to point an `<img>`/`<video>` at as-is. */
function remoteUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim())
    ? value.trim()
    : undefined;
}

/**
 * Normalize one string field that might be a data URL, a bare base64 blob, or
 * a remote URL — the three things that turn up in `data`, `url`, `src` and
 * `image` fields with no reliable way to tell which from the key alone.
 */
function fromString(value: unknown, declared?: string): InlineMedia | null {
  if (typeof value !== "string" || !value) return null;
  const url = remoteUrl(value);
  if (url) return { url, mimeType: declared };
  const data = parseDataUrl(value);
  if (data) return { base64: data.base64, mimeType: declared ?? data.mimeType };
  // A bare base64 blob. Require some length so a short word in a `url` field
  // isn't mistaken for a one-pixel image.
  const cleaned = stripBase64Whitespace(value);
  return cleaned.length >= 16 ? { base64: cleaned, mimeType: declared } : null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** First defined media type among the candidates. */
const pickMime = (...v: unknown[]): string | undefined => v.map(str).find(Boolean);

/**
 * Decide whether a content block carries inline media, and pull it out.
 *
 * Returns null for text, for tool plumbing, and for blocks that REFERENCE a
 * file rather than carrying it (those are `parseAssetReference`'s job, over in
 * the server — a reference needs a filesystem, this needs nothing).
 */
export function parseInlineMedia(block: unknown): InlineMedia | null {
  if (typeof block === "string") {
    const data = parseDataUrl(block);
    return data ? { base64: data.base64, mimeType: data.mimeType } : null;
  }
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const type = str(b.type);
  const alt = pickMime(b.alt, b.name, b.title, b.caption);

  // OpenAI's shape. `image_url` is usually an object but is sometimes flattened
  // to the bare string by SDKs that "simplify" it.
  if (type === "image_url" || b.image_url !== undefined) {
    const holder = b.image_url;
    const value =
      typeof holder === "string"
        ? holder
        : holder && typeof holder === "object"
          ? (holder as Record<string, unknown>).url
          : undefined;
    const found = fromString(value, pickMime(b.mimeType, b.mime_type));
    if (found) return { ...found, alt: alt ?? found.alt };
  }

  // MCP's EmbeddedResource. Both spellings of the payload matter: `blob` is
  // base64 bytes, and `text` is the route an SVG takes — the one image format
  // that travels as source rather than as a binary.
  if (type === "resource" && b.resource && typeof b.resource === "object") {
    const r = b.resource as Record<string, unknown>;
    const mime = pickMime(r.mimeType, r.mime_type);
    const label = pickMime(r.name, r.title) ?? alt;
    const blob = str(r.blob);
    if (blob) {
      const found = fromString(blob, mime);
      if (found) return { ...found, alt: label };
    }
    const text = str(r.text);
    // Only claim a text resource when it is one we can actually render:
    // an image/* type (SVG), or a payload that is itself a data URL. Plain
    // text with a `text/plain` type is a tool result, not a picture.
    if (text) {
      const inline = parseDataUrl(text);
      if (inline) return { base64: inline.base64, mimeType: mime ?? inline.mimeType, alt: label };
      if (mime && /^image\//i.test(mime)) {
        return { base64: utf8ToBase64(text), mimeType: mime, alt: label };
      }
    }
    return null;
  }

  if (type === "image" || type === "audio" || type === "video") {
    const declared = pickMime(b.mimeType, b.mime_type, b.media_type, b.mediaType);

    // Anthropic nests the payload under `source`.
    const source = b.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      const sMime = pickMime(s.media_type, s.mediaType, s.mimeType, s.mime_type) ?? declared;
      const found =
        fromString(s.data, sMime) ?? fromString(s.url, sMime) ?? fromString(s.uri, sMime);
      if (found) return { ...found, alt };
    }
    if (typeof source === "string") {
      const found = fromString(source, declared);
      if (found) return { ...found, alt };
    }

    // Flat payloads, in the order of how likely the key is to mean "the bytes".
    for (const key of ["data", "url", "src", "uri", "image", "base64", "b64_json"]) {
      const found = fromString(b[key], declared);
      if (found) return { ...found, alt };
    }
    return null;
  }

  // A text block that is nothing but a data URL. An agent that prints one
  // meant it to be looked at, not read as a 40 KB word.
  if (type === "text" || type === undefined) {
    const text = str(b.text) ?? str(b.content);
    if (text && text.trim().toLowerCase().startsWith("data:")) {
      const data = parseDataUrl(text);
      if (data) return { base64: data.base64, mimeType: data.mimeType, alt };
    }
  }

  return null;
}

/**
 * Data URLs embedded in a run of prose, with the span each one occupied.
 *
 * Used to lift a data URL OUT of an assistant's markdown so the bytes become a
 * real attachment instead of a 40 KB unreadable line in the transcript. Spans
 * come back so the caller can splice the text without re-searching it.
 */
export function findDataUrls(text: string): Array<{ start: number; end: number; media: InlineMedia }> {
  const out: Array<{ start: number; end: number; media: InlineMedia }> = [];
  // A fresh global regex per call: a shared `lastIndex` across calls is the
  // classic way this silently skips every other match.
  const re = new RegExp(DATA_URL_RE.source, "gi");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const parsed = parseDataUrl(m[0]);
    if (parsed) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        media: { base64: parsed.base64, mimeType: parsed.mimeType },
      });
    }
    // A zero-length match would spin forever.
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return out;
}

/**
 * File extensions worth previewing when one merely APPEARS in prose.
 *
 * Kept narrow on purpose. This drives "the agent wrote a chart and only
 * mentioned the path", so it must catch what agents actually generate without
 * turning every `.json` in a transcript into a media chip.
 */
const PREVIEWABLE_EXT =
  /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif|mp4|m4v|mov|webm|ogv|mp3|wav|m4a|oga|flac)$/i;

/** Does this path look like something worth showing rather than linking? */
export function isPreviewablePath(path: string): boolean {
  // Strip a query/fragment first: `chart.png?v=2` is still a chart.
  const bare = path.split(/[?#]/)[0] ?? path;
  return PREVIEWABLE_EXT.test(bare);
}
