/**
 * ARTIFACTS — a rendered thing an agent publishes for the human to LOOK at:
 * an HTML page, an SVG, a Markdown document, a code listing. Shown in a pane
 * beside the chat rather than as a fenced block in it, versioned, and expired
 * by the retention sweep (`RetentionSettings.artifactDays`, 7 days by default).
 *
 * Created through the `dispatch-artifacts` MCP tools, not by parsing tags out of
 * assistant prose. A tool call is provider-neutral — every runtime gets the
 * injected servers — and it lands in the transcript as a structured row, where
 * a tag is whatever one provider's model happened to emit and a parser has to
 * guess where it ends.
 *
 * Storage is files, like transcripts and assets: `chats/<id>/artifacts/<aid>/`
 * holds `meta.json` plus one `v<n>.<ext>` per version. Versions are never
 * rewritten, so "show me what it looked like before that edit" is a read.
 */
import * as z from "zod";

/** What the viewer knows how to draw. Order is the order a picker lists them. */
export const ARTIFACT_TYPES = ["html", "svg", "markdown", "code"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);

/**
 * Largest single version's MAIN document (the HTML, SVG, Markdown or code).
 *
 * Was 1 MiB, which a game probe hit at once: a self-contained page that
 * inlines its engine is several megabytes of JavaScript before a single
 * texture. 8 MiB fits an inlined engine; anything bigger — textures, models,
 * audio, wasm — belongs in the version's ASSETS, which are stored once by
 * content hash instead of being re-copied into every version's document.
 */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

/** Largest single asset file. */
export const ARTIFACT_ASSET_MAX_BYTES = 64 * 1024 * 1024;
/**
 * All of one version's assets together. Every one of them is shipped to the
 * browser before the page boots, so this is also the download a human waits
 * through when they open the artifact.
 */
export const ARTIFACT_ASSETS_MAX_BYTES = 256 * 1024 * 1024;
/** Files per version — a build output with more than this is not one page. */
export const ARTIFACT_ASSETS_MAX_FILES = 2000;
/**
 * How much of a version's main document `artifact_read` hands the model. The
 * agent published it, usually from a file it still has; past this the content
 * is context the model pays for and does not need.
 */
export const ARTIFACT_READ_CONTENT_MAX = 100_000;
/** Versions kept per artifact. Past this the OLDEST are dropped, never the newest. */
export const ARTIFACT_MAX_VERSIONS = 50;
export const ARTIFACT_TITLE_MAX = 120;
/** Runtime errors remembered per version, and how long each may be. */
export const ARTIFACT_MAX_ERRORS = 20;
export const ARTIFACT_ERROR_MAX_CHARS = 2_000;

/**
 * Per-artifact `localStorage`, in UTF-16 code units of keys plus values — the
 * unit and roughly the size Chromium gives a real origin, so a page tuned
 * against a browser behaves the same here. Shared by every version of the
 * artifact: a save game must survive the agent editing the game.
 */
export const ARTIFACT_STORAGE_MAX_CHARS = 5 * 1024 * 1024;
/** One key's length. Longer than any sane key, short enough to keep a log line readable. */
export const ARTIFACT_STORAGE_KEY_MAX = 1024;

/** `GET /api/chats/:id/artifacts/:aid/storage` */
export interface ArtifactStorage {
  entries: Record<string, string>;
  /** Keys plus values, in UTF-16 code units — what the quota is measured in. */
  chars: number;
}

/**
 * One batch of writes from the viewer. `clear` applies FIRST, then `set`; a
 * `null` value removes the key. The order matters: a page that calls `clear()`
 * then `setItem()` within one debounce window must end up with the new item.
 */
export const ArtifactStoragePatchSchema = z.object({
  clear: z.boolean().optional(),
  set: z.record(z.string().min(1).max(ARTIFACT_STORAGE_KEY_MAX), z.string().nullable()).default({}),
});
export type ArtifactStoragePatch = z.infer<typeof ArtifactStoragePatchSchema>;

/** Size of a storage map in the quota's unit. */
export function artifactStorageChars(entries: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(entries)) n += k.length + v.length;
  return n;
}

/** File extension a version is stored under. Only cosmetic — never served raw. */
export function artifactExtension(type: ArtifactType, language?: string): string {
  if (type === "html") return "html";
  if (type === "svg") return "svg";
  if (type === "markdown") return "md";
  const lang = (language ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return lang ? lang.slice(0, 12) : "txt";
}

/** A content-hash name: lowercase hex SHA-256. Checked before it is ever joined onto a path. */
export const ARTIFACT_BLOB_ID = /^[0-9a-f]{64}$/;

/** One asset in a version's manifest. The bytes live once per chat, named by `sha256`. */
export const ArtifactAssetSchema = z.object({
  sha256: z.string().regex(ARTIFACT_BLOB_ID),
  size: z.number().int().nonnegative(),
  /** MIME type, from the file name. `fetch()` of a blob reports it as Content-Type. */
  type: z.string(),
});
export type ArtifactAsset = z.infer<typeof ArtifactAssetSchema>;

export const ArtifactVersionSchema = z.object({
  n: z.number().int().positive(),
  createdAt: z.number(),
  size: z.number().int().nonnegative(),
  /**
   * Files the page loads, keyed by their path relative to the asset directory
   * (`textures/hero.ktx2`). Absent for a version with none — every artifact
   * before asset bundles.
   */
  assets: z.record(z.string(), ArtifactAssetSchema).optional(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactMetaSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  title: z.string(),
  type: ArtifactTypeSchema,
  /** Language of a `code` artifact, for highlighting. */
  language: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Oldest first. The last entry is the current version. */
  versions: z.array(ArtifactVersionSchema),
  /**
   * When retention deleted the content. The meta survives so a transcript card
   * can say "expired" rather than "not found" — the transcript names the
   * artifact forever and can never be rewritten.
   */
  expiredAt: z.number().optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

/** `GET /api/chats/:id/artifacts/:aid` */
export interface ArtifactContent {
  meta: ArtifactMeta;
  version: number;
  content: string;
  /** Runtime errors the viewer reported for THIS version, newest last. */
  errors: string[];
  /** This version's asset manifest; fetch each by `sha256` from the blob route. */
  assets?: Record<string, ArtifactAsset>;
}

/** Total bytes of a manifest. */
export function artifactAssetsBytes(assets: Record<string, ArtifactAsset> | undefined): number {
  let n = 0;
  for (const a of Object.values(assets ?? {})) n += a.size;
  return n;
}

/**
 * The key an asset is stored and looked up under: forward slashes, no leading
 * `./` or `/`, no `..`, no empty segments. Null when the path cannot name a
 * file inside the bundle — which is a refusal, never a guess.
 */
export function normalizeAssetPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  if (!out.length) return null;
  const joined = out.join("/");
  return /[\u0000-\u001f]/.test(joined) ? null : joined;
}

/**
 * MIME type for an asset, by extension. Not the server's media table: that one
 * answers "can this be previewed", while this has to be right for the loaders
 * that check — `WebAssembly.instantiateStreaming` refuses anything but
 * `application/wasm`, and a module script refuses a non-JavaScript type.
 */
export function artifactAssetType(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return ASSET_TYPES[ext] ?? "application/octet-stream";
}

const ASSET_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  cjs: "text/javascript", json: "application/json", map: "application/json", txt: "text/plain",
  xml: "application/xml", svg: "image/svg+xml", wasm: "application/wasm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", ktx2: "image/ktx2", ktx: "image/ktx",
  basis: "application/octet-stream", dds: "image/vnd-ms.dds", hdr: "image/vnd.radiance", exr: "image/x-exr",
  glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", stl: "model/stl", bin: "application/octet-stream",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
  opus: "audio/ogg", mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

/** Types whose text may name OTHER assets, and so get their references rewritten in the frame. */
export function isRewritableAssetType(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "image/svg+xml" ||
    type === "model/gltf+json"
  );
}

/** The newest version number, or 0 for a meta with none (never stored that way). */
export function latestArtifactVersion(meta: Pick<ArtifactMeta, "versions">): number {
  return meta.versions.at(-1)?.n ?? 0;
}

/* --------------------------------------------------- transcript reference */

/**
 * The machine-readable line every artifact tool result ends with.
 *
 * The transcript card needs the id and version a call produced, and the id of a
 * CREATE is minted server-side — it is not in the call's input. The result text
 * is the only durable place it can ride, so it rides as one tagged JSON line the
 * card parses and the model reads past.
 */
export const ARTIFACT_REF_TAG = "dispatch-artifact:";

export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
  type: ArtifactType;
}

export function formatArtifactRef(ref: ArtifactRef): string {
  return `${ARTIFACT_REF_TAG}${JSON.stringify(ref)}`;
}

/** The ref in a tool result's text, or null when there is none (an error result). */
export function parseArtifactRef(text: string | undefined | null): ArtifactRef | null {
  if (!text) return null;
  const at = text.lastIndexOf(ARTIFACT_REF_TAG);
  if (at < 0) return null;
  const line = text.slice(at + ARTIFACT_REF_TAG.length).split("\n", 1)[0] ?? "";
  try {
    const raw = JSON.parse(line) as Partial<ArtifactRef>;
    if (typeof raw.id !== "string" || typeof raw.version !== "number") return null;
    const type = ArtifactTypeSchema.safeParse(raw.type);
    return {
      id: raw.id,
      version: raw.version,
      title: typeof raw.title === "string" ? raw.title : "Artifact",
      type: type.success ? type.data : "html",
    };
  } catch {
    return null;
  }
}

/**
 * Apply one `old_str → new_str` edit, the way the agent's own file-edit tools
 * do: the old string must occur EXACTLY once. Zero means the agent is editing
 * something it misremembers; two means the edit is ambiguous. Either way the
 * honest answer is an error that says which, never a guess.
 */
export function applyArtifactEdit(
  content: string,
  oldStr: string,
  newStr: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!oldStr) return { ok: false, error: "old_str is empty." };
  const first = content.indexOf(oldStr);
  if (first < 0) return { ok: false, error: "old_str does not occur in the current version." };
  if (content.indexOf(oldStr, first + 1) >= 0) {
    return { ok: false, error: "old_str occurs more than once — include more surrounding text so it is unique." };
  }
  return { ok: true, content: content.slice(0, first) + newStr + content.slice(first + oldStr.length) };
}
