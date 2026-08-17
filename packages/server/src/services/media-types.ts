/**
 * One table for "what is this file", shared by the chat-asset route and the MCP
 * result normalizer. It lived in both, in opposite directions, and the two
 * drifted: the route knew about `.bmp` and the normalizer didn't.
 *
 * Video and audio are here because an MCP that records a run has no way to hand
 * it back otherwise — see `mcp-assets.ts` for how a large artifact arrives as a
 * PATH rather than as base64 in the model's context window.
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
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".oga",
  "audio/webm": ".weba",
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
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".oga": "audio/ogg",
  ".weba": "audio/webm",
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
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? fallback;
}

// `mediaKind` / `formatBytes` live in @dispatch/shared: the server picks the
// kind when ingesting and the CLIENT picks the element to render it with, so a
// second copy here would be a copy that drifts.
export { mediaKind, formatBytes, type MediaKind } from "@dispatch/shared";
