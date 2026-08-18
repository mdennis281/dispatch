import { useState } from "react";
import type { ImageRef } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { Attachment } from "./Attachment.js";
import { MediaViewer } from "./MediaViewer.js";

/**
 * A row of attachments that share ONE viewer.
 *
 * Every place media appears — the user's turn, a tool result, an assistant's
 * markdown — renders through here, which buys two things a per-thumbnail
 * lightbox could not:
 *
 *   • ← / → step through the whole group. A tool that returns eight screenshots
 *     used to mean eight open-look-close cycles.
 *   • one implementation of the chrome. Before this, the tool card had its own
 *     inline `<img>` + lightbox that had drifted from `ImageThumb`'s — different
 *     captions, no dimensions, and no zoom on one of the two paths.
 */
export function MediaGroup({
  chatId,
  assets,
  className,
}: {
  chatId: string;
  assets: ImageRef[];
  className?: string;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (!assets.length) return null;

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {assets.map((asset, index) => (
          <Attachment
            key={asset.id || `${asset.path}-${index}`}
            chatId={chatId}
            asset={asset}
            onOpen={() => setOpenAt(index)}
          />
        ))}
      </div>
      {openAt !== null && (
        <MediaViewer
          chatId={chatId}
          assets={assets}
          index={openAt}
          onClose={() => setOpenAt(null)}
        />
      )}
    </>
  );
}
