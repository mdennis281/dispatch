import { useState } from "react";
import { ImageIcon } from "lucide-react";
import type { ImageRef } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { useAssetSrc } from "../../../lib/assetSrc.js";
import { MediaViewer, assetName } from "./MediaViewer.js";

/** How much room this thumbnail gets. See {@link MediaGroup} for the choice. */
export type ThumbVariant = "single" | "tile";

/**
 * One image thumbnail — a real preview via the chat's asset endpoint with a
 * labelled card fallback if the bytes can't load. Shared by the user turn
 * (pasted/dropped attachments), the tool card (images a tool returned), and the
 * assistant's own markdown.
 *
 * `onOpen` hands the click to {@link MediaGroup}, so the viewer it opens can
 * walk the whole chat. Standalone (no `onOpen`) it still opens a viewer of its
 * own, because plenty of call sites have exactly one image.
 */
export function ImageThumb({
  chatId,
  img,
  onOpen,
  variant = "single",
}: {
  chatId: string;
  img: ImageRef;
  onOpen?: () => void;
  variant?: ThumbVariant;
}) {
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const name = assetName(img);
  const dims = img.width && img.height ? `${img.width}×${img.height}` : undefined;
  const { src, failed } = useAssetSrc(chatId, img);
  const broken = failed || decodeFailed;
  const tile = variant === "tile";

  if (broken) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1.5">
        <span
          className="flex size-9 items-center justify-center rounded-[5px] border border-line-soft bg-[repeating-conic-gradient(#191d23_0deg_90deg,#14181d_90deg_180deg)] bg-[length:12px_12px] text-muted [&_svg]:size-4"
          aria-hidden
        >
          <ImageIcon />
        </span>
        <div className="leading-tight">
          <div className="text-xs text-secondary">{name}</div>
          {dims && <div className="cm-mono !text-2xs text-faint">{dims}</div>}
        </div>
      </div>
    );
  }

  return (
    <>
      <figure
        className={cn(
          "overflow-hidden rounded-md border border-line bg-inset",
          // A tile carries no caption bar — its filename is the tooltip. Five
          // captions stacked under five tiles is more text than picture.
          tile && "w-[132px]",
        )}
      >
        {/* Nothing to enlarge until the bytes land — don't advertise a zoom
            affordance (or take focus) for a click that would do nothing. */}
        <button
          type="button"
          disabled={!src}
          onClick={() => (onOpen ? onOpen() : setZoomed(true))}
          className={cn(
            "block w-full outline-none focus-visible:ring-1 focus-visible:ring-accent-line",
            src ? "cursor-zoom-in" : "cursor-default",
          )}
          title={src ? name : undefined}
        >
          {src ? (
            <img
              src={src}
              alt={img.alt ?? name}
              onError={() => setDecodeFailed(true)}
              // A checkerboard behind the image, so a transparent PNG reads as
              // transparent instead of as a picture with a hole in it — the
              // thing that most often looks like "the image is broken".
              className={cn(
                "block bg-[repeating-conic-gradient(#191d23_0deg_90deg,#14181d_90deg_180deg)] bg-[length:12px_12px]",
                tile
                  ? // Uniform squares, cropped: a contact sheet only reads as a
                    // set if the cells line up, and letterboxing five different
                    // aspect ratios into one row does the opposite.
                    "h-[132px] w-[132px] object-cover"
                  : "max-h-72 max-w-[420px] object-contain",
              )}
            />
          ) : (
            // The bytes are still being fetched. Hold the row's height so a
            // transcript doesn't jump as thumbnails resolve.
            <span
              className={cn("block animate-pulse bg-panel-2", tile ? "size-[132px]" : "h-40 w-[280px]")}
              aria-hidden
            />
          )}
        </button>
        {!tile && (
          <figcaption className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1">
            <span className="truncate text-2xs text-secondary">{name}</span>
            {dims && <span className="cm-mono !text-2xs text-faint">{dims}</span>}
          </figcaption>
        )}
      </figure>
      {zoomed && (
        <MediaViewer chatId={chatId} assets={[img]} path={img.path} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}
