/**
 * One table for "what kind of file is this", by name.
 *
 * It lived on the server, which was fine while only the server had to decide.
 * It doesn't any more: the client now resolves media the agent referred to BY
 * PATH (`![chart](out/chart.png)`), and has to pick an element to render it
 * with before any bytes have arrived. A second copy of this table in the client
 * is a second copy that drifts — which is exactly how `.bmp` ended up known to
 * one side and not the other the last time these were duplicated.
 *
 * The server still prefers SNIFFED types over anything derived here (see
 * `media-sniff.ts`); this is the answer for when there are no bytes to look at.
 */

/** Canonical extension for each media type we knowingly store. */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".oga",
  "audio/webm": ".weba",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "application/zip": ".zip",
  "application/json": ".json",
  "text/plain": ".txt",
  "application/pdf": ".pdf",
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".oga": "audio/ogg",
  ".weba": "audio/webm",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".zip": "application/zip",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".pdf": "application/pdf",
};

/** Extension for a media type. `fallback` is what an unknown type becomes. */
export function extFromMediaType(mime: string | undefined, fallback = ".png"): string {
  return EXT_BY_MIME[(mime ?? "").toLowerCase()] ?? fallback;
}

/**
 * Media type for a filename. Unknown extensions become
 * `application/octet-stream` — a browser shown that will DOWNLOAD the file
 * rather than try to render it as a broken image, which is the honest outcome.
 */
export function mediaTypeFromName(name: string, fallback = "application/octet-stream"): string {
  // Strip a query/fragment before looking at the extension: `chart.png?v=2`
  // otherwise has an extension of `.png?v=2` and matches nothing.
  const bare = name.split(/[?#]/)[0] ?? name;
  const dot = bare.lastIndexOf(".");
  const ext = dot >= 0 ? bare.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? fallback;
}

/**
 * Media type for a path, with `undefined` rather than a fallback for unknowns.
 *
 * The distinction matters at the call sites that build an `ImageRef` from a
 * mere mention: saying `application/octet-stream` there would make `mediaKind`
 * report `file` and render a download chip, when "we don't know yet, go look at
 * the bytes" is the truth and the server is about to sniff it anyway.
 */
export function mediaTypeFromPath(path: string): string | undefined {
  const mime = mediaTypeFromName(path, "");
  return mime || undefined;
}
