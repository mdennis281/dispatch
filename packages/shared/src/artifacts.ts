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
 * Largest single version. An artifact is something a human reads in a pane; a
 * megabyte of HTML is already well past that, and the bound is what keeps a
 * runaway `path` (a build output, a log) from being copied in wholesale.
 */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;
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

export const ArtifactVersionSchema = z.object({
  n: z.number().int().positive(),
  createdAt: z.number(),
  size: z.number().int().nonnegative(),
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
