import { useState, type CSSProperties } from "react";
import { Images } from "lucide-react";
import type { ImageRef } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { indexOfAsset, useChatMedia } from "../../../lib/chatMedia.js";
import { Attachment } from "./Attachment.js";
import type { ThumbVariant } from "./ImageThumb.js";
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
/**
 * Layout for `fill` thumbnails: big while there are few, smaller as they add up,
 * then more rows. There is no sideways scrolling. A swipeable strip hid every
 * screenshot past the third behind a gesture nobody made.
 *
 * - One shot keeps its own aspect, up to a generous height.
 * - Two or three share a row, shorter as the row fills.
 * - After three, each row holds three and the rest wrap underneath.
 *
 * `auto-fill` with a floor on the column width is what drops a phone-width
 * card to two per row instead of three unreadably narrow ones.
 */
function fillGrid(count: number): CSSProperties {
  const cols = Math.min(count, 3);
  const gap = "0.5rem";
  return {
    gridTemplateColumns:
      `repeat(auto-fill, minmax(max(140px, calc((100% - ${cols - 1} * ${gap}) / ${cols})), 1fr))`,
    ["--thumb-h" as string]: cols === 1 ? "auto" : cols === 2 ? "14rem" : "10rem",
    ["--thumb-max-h" as string]: cols === 1 ? "22rem" : "none",
  };
}

export function MediaGroup({
  chatId,
  assets,
  className,
  variant,
}: {
  chatId: string;
  assets: ImageRef[];
  className?: string;
  /** Force one thumbnail size for every image instead of choosing by count. */
  variant?: ThumbVariant;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Only asked for once something opens: the gallery is a whole-transcript
  // read, and no row needs it merely to draw its thumbnails.
  const gallery = useChatMedia(chatId, openPath !== null);
  if (!assets.length) return null;

  const tiled = assets.length > 1;

  // The chat-wide gallery is the sequence to walk — but ONLY when it actually
  // contains the image that was clicked. A markdown embed or a prose chip is
  // neither a tool result nor an attachment, so it is not a member; opening the
  // chat gallery anyway would land on whatever happened to be first and show
  // the wrong picture. Falling back to this row is always right, just shorter.
  //
  // This list CHANGES under the viewer: it opens on the row and is replaced by
  // the chat-wide gallery once that request lands, which is exactly why the
  // viewer identifies its image by path rather than by position.
  const inGallery = openPath !== null && indexOfAsset(gallery, openPath) >= 0;
  const viewerAssets = inGallery ? gallery.map((item) => item.asset) : assets;

  return (
    <>
      <div className={cn("min-w-0", className)}>
        {tiled && (
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-faint [&_svg]:size-3">
            <Images />
            <span>{assets.length} images</span>
          </div>
        )}
        <div
          className={cn(
            variant === "fill" ? "grid gap-2" : cn("flex flex-wrap", tiled ? "gap-1.5" : "gap-2"),
          )}
          style={variant === "fill" ? fillGrid(assets.length) : undefined}
        >
          {assets.map((asset, index) => (
            <Attachment
              key={asset.id || `${asset.path}-${index}`}
              chatId={chatId}
              asset={asset}
              variant={variant ?? (tiled ? "tile" : "single")}
              onOpen={() => setOpenPath(asset.path)}
            />
          ))}
        </div>
      </div>
      {openPath !== null && (
        <MediaViewer
          chatId={chatId}
          assets={viewerAssets}
          path={openPath}
          onClose={() => setOpenPath(null)}
        />
      )}
    </>
  );
}
