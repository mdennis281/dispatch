import { useMemo } from "react";
import {
  labelForAsset,
  mergeImages,
  recoverResultMedia,
  type ToolResultRow,
  type ToolUseRow,
} from "@dispatch/shared";
import { MediaGroup } from "./MediaGroup.js";
import { cn } from "../../../lib/cn.js";

/**
 * Every image a group of tool results produced, rendered once.
 *
 * WHY THIS EXISTS: ingest was never the problem. A `Read` of a PNG arrives with
 * its bytes persisted to the chat's assets and a perfectly good `ImageRef` — and
 * then nothing drew it, because `Read` is a FILE tool and file tools render
 * through `FileRunGroup`, which only ever drew a filename and a line count.
 * Same for `ShellRunGroup`, `PrRunGroup`, `SubagentCard` and
 * `DispatchToolCard`: five of the seven renderers dropped `result.images` on
 * the floor. Only `ToolCallCard` and `UserRow` ever showed one.
 *
 * That is why "the agent clearly saw the image" and the transcript showed
 * nothing — the two facts were about different halves of the pipeline.
 *
 * So the display lives HERE, in one component every renderer mounts, rather
 * than being re-implemented per card. A renderer added next year gets images by
 * mounting this; it cannot forget a field it never has to know about.
 */
export function ResultMediaStrip({
  chatId,
  results,
  uses,
  className,
}: {
  chatId: string;
  /** The results of one group. `undefined` entries (still running) are fine. */
  results: (ToolResultRow | undefined)[];
  /**
   * The tool calls that produced them, positionally matched to `results`.
   *
   * Only used for the CAPTION: a stored asset is content-addressed
   * (`kEE0Q1yjaoffNb8tVDGmR.png`), which is right on disk and unreadable in a
   * caption. The call still knows the path the agent asked for.
   */
  uses?: (ToolUseRow | undefined)[];
  className?: string;
}) {
  const assets = useMemo(() => {
    const out = results.flatMap((result, i) =>
      result
        ? // Server refs first, then anything recovered from a stored payload the
          // ingest path didn't recognize when it was written. `mergeImages`
          // drops the duplicate a current message produces via both routes.
          mergeImages(result.images, recoverResultMedia(result.content).images).map((asset) => {
            const alt = labelForAsset(asset, uses?.[i]);
            return alt ? { ...asset, alt } : asset;
          })
        : [],
    );
    // A group can repeat one file — an agent re-reading the same screenshot
    // after an edit is the normal case, and showing it four times is noise.
    const seen = new Set<string>();
    const deduped: typeof out = [];
    for (const img of out) {
      if (seen.has(img.path)) continue;
      seen.add(img.path);
      deduped.push(img);
    }
    return deduped;
  }, [results, uses]);

  if (!assets.length) return null;
  return (
    <MediaGroup
      chatId={chatId}
      assets={assets}
      className={cn("border-t border-line-soft px-2.5 py-2", className)}
    />
  );
}
