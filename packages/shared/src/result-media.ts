import { parseInlineMedia } from "./media-blocks.js";
import type { ImageRef } from "./common.js";

/**
 * Recovering media from a tool result AT RENDER TIME.
 *
 * The server persists agent media into chat assets as it arrives, and hands the
 * client small `ImageRef`s. But that only ever helps messages received AFTER
 * the ingest path learned the shape in question — and the whole reason this
 * work exists is that it kept not knowing one. Every transcript already on disk
 * holds images that were stored raw, in a spelling nothing understood.
 *
 * So the client re-parses stored content through the SAME `parseInlineMedia`
 * the server ingests with. A message written a year ago by a provider whose
 * shape was only just added starts rendering on the next paint, with no
 * migration and no rewrite of history.
 *
 * Also sanitizes: a recovered payload is replaced with a short placeholder in
 * the content shown in the raw-result pane, so a 4 MB base64 blob doesn't get
 * pasted into a `<pre>` and freeze the tab.
 */

/** What a walk found: renderable refs, plus content safe to display as text. */
export interface RecoveredMedia {
  images: ImageRef[];
  content: unknown;
}

/**
 * Bound the recursion.
 *
 * Counts EVERY structural step — an array element, an object value, a parsed
 * nested result — not just the interesting ones. Incrementing only on the
 * nested-result hop left arrays and plain objects recursing without limit, so a
 * deeply nested payload could blow the stack in the middle of a render, which
 * takes the transcript down rather than just failing to find an image.
 *
 * Generous, because it is now measuring ordinary nesting too: a serialized
 * result inside a serialized result is roughly six levels, and legitimate tool
 * output is nested well past four.
 */
const MAX_DEPTH = 24;

/**
 * Pull every renderable image out of a stored tool-result `content`.
 *
 * Deterministic and cheap enough to run inside a `useMemo` on every render of
 * every tool card — no fetching, no decoding, just shape inspection.
 */
export function recoverResultMedia(content: unknown, chatId?: string): RecoveredMedia {
  const images: ImageRef[] = [];
  const walked = walk(content, images, 0, chatId ?? "", { n: 0 });
  return { images, content: walked };
}

/** A stable-enough id: recovered refs are keyed by position, not identity. */
function refId(seq: { n: number }): string {
  seq.n += 1;
  return `recovered-${seq.n}`;
}

function walk(
  node: unknown,
  images: ImageRef[],
  depth: number,
  chatId: string,
  seq: { n: number },
): unknown {
  if (depth > MAX_DEPTH) return node;

  if (Array.isArray(node)) {
    return node.map((child) => walk(child, images, depth + 1, chatId, seq));
  }

  // A JSON string holding a serialized CallToolResult — the shape a bridged MCP
  // server produces. Re-serialize after walking so the pane shows the sanitized
  // version rather than the megabyte it replaced.
  if (typeof node === "string") {
    const media = parseInlineMedia(node);
    if (media) {
      const ref = toRef(media, seq);
      if (ref) {
        images.push(ref);
        return "[image]";
      }
    }
    if (node.trimStart().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(node);
        const before = images.length;
        const inner = walk(parsed, images, depth + 1, chatId, seq);
        if (images.length > before) return JSON.stringify(inner, null, 2);
      } catch {
        // Ordinary text that merely opens with a brace. Untouched.
      }
    }
    return node;
  }

  if (!node || typeof node !== "object") return node;
  const block = node as Record<string, unknown>;

  // A block the SERVER already normalized: the bytes are in chat assets and it
  // left a pointer. Nothing to recover, but it still has to become a ref or the
  // image only shows for as long as `result.images` is populated.
  const asset = typeof block.asset === "string" ? block.asset : undefined;
  if (block.type === "image" && asset) {
    images.push({
      id: refId(seq),
      path: asset,
      mimeType: typeof block.media_type === "string" ? block.media_type : undefined,
    });
    return block;
  }

  const media = parseInlineMedia(block);
  if (media) {
    const ref = toRef(media, seq);
    if (ref) {
      images.push(ref);
      // Keep the block's own shape, minus the payload — the raw pane should
      // still show that an image block was here, just not its bytes.
      const { data: _d, source: _s, blob: _b, image_url: _i, ...rest } = block;
      return { ...rest, data: "[rendered image]" };
    }
  }

  // Every value, not a whitelist of `content`/`structuredContent`/`result`.
  // The whitelist saved nothing — the other keys were walked anyway, just at
  // the same depth — and it meant a server that named its payload something
  // else got a shallower search for no reason.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    out[key] = walk(value, images, depth + 1, chatId, seq);
  }
  return out;
}

/**
 * An `InlineMedia` as something `useAssetSrc` can resolve.
 *
 * Inline bytes become a `data:` URL rather than being uploaded: this is a
 * READ-time repair of an already-stored message, and it must not have side
 * effects. `directSrc` passes a data URL straight through to the DOM, so it
 * renders without a fetch.
 */
function toRef(
  media: ReturnType<typeof parseInlineMedia>,
  seq: { n: number },
): ImageRef | null {
  if (!media) return null;
  if (media.url) {
    return { id: refId(seq), path: media.url, mimeType: media.mimeType, alt: media.alt };
  }
  if (!media.base64) return null;
  const mime = media.mimeType ?? "image/png";
  return {
    id: refId(seq),
    path: `data:${mime};base64,${media.base64}`,
    mimeType: mime,
    alt: media.alt,
  };
}

/**
 * Merge server-supplied refs with recovered ones, dropping duplicates.
 *
 * Both sources are live at once during the transition: a message received today
 * has real `ImageRef`s AND a sanitized `{type:"image", asset}` block that the
 * walk above turns into a second ref for the same file. Keying by `path` is
 * what stops every current screenshot from rendering twice.
 */
export function mergeImages(
  fromServer: ImageRef[] | undefined,
  recovered: ImageRef[],
): ImageRef[] {
  const seen = new Set((fromServer ?? []).map((i) => i.path));
  return [...(fromServer ?? []), ...recovered.filter((i) => !seen.has(i.path))];
}
