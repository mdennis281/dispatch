import { useState } from "react";
import { Images } from "lucide-react";
import type { ImageRef } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { indexOfAsset, useChatMedia } from "../../../lib/chatMedia.js";
import { Attachment } from "./Attachment.js";
import { MediaViewer } from "./MediaViewer.js";

/**
 * The media a row produced, laid out for how many of it there are.
 *
 * ONE image is the thing the message is about, so it gets room — a 240px
 * thumbnail marooned in a full-width card read as an afterthought next to the
 * filename above it.
 *
 * SEVERAL images are a contact sheet. An agent that reads five renders in a row
 * is showing you a set, and five stacked cards each with their own caption bar
 * is a wall to scroll past rather than something you can take in. They become
 * uniform tiles under one count, which also makes "these belong together"
 * visible at a glance.
 *
 * Clicking any of them opens the viewer on the CHAT's whole gallery rather than
 * on this row's slice — see `useChatMedia` for why that is the useful sequence.
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
  const [openPath, setOpenPath] = useState<string | null>(null);
  const gallery = useChatMedia(chatId);
  if (!assets.length) return null;

  // The chat-wide gallery is the sequence to walk. It can legitimately be empty
  // of THIS asset — a markdown embed or a prose chip is not a tool result — so
  // fall back to the group, which is always right even if it is short.
  const galleryAssets = gallery.length ? gallery.map((item) => item.asset) : assets;
  const tiled = assets.length > 1;

  return (
    <>
      <div className={cn("min-w-0", className)}>
        {tiled && (
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-faint [&_svg]:size-3">
            <Images />
            <span>{assets.length} images</span>
          </div>
        )}
        <div className={cn("flex flex-wrap", tiled ? "gap-1.5" : "gap-2")}>
          {assets.map((asset, index) => (
            <Attachment
              key={asset.id || `${asset.path}-${index}`}
              chatId={chatId}
              asset={asset}
              variant={tiled ? "tile" : "single"}
              onOpen={() => setOpenPath(asset.path)}
            />
          ))}
        </div>
      </div>
      {openPath !== null && (
        <MediaViewer
          chatId={chatId}
          assets={galleryAssets}
          index={indexOfAsset(
            gallery.length ? gallery : assets.map((asset) => ({ asset, rowId: "" })),
            openPath,
          )}
          onClose={() => setOpenPath(null)}
        />
      )}
    </>
  );
}
