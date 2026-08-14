import { useState } from "react";
import { ImageIcon } from "lucide-react";
import type { ImageRef } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { useAssetSrc } from "../../../lib/assetSrc.js";
import { ImageLightbox } from "./ImageLightbox.js";

/**
 * One image thumbnail — a real preview via the chat's asset endpoint with a
 * labelled card fallback if the bytes can't load. Shared by the user turn
 * (pasted/dropped attachments) and the tool card (images a tool returned, e.g.
 * a Claude-in-Chrome screenshot).
 */
export function ImageThumb({ chatId, img }: { chatId: string; img: ImageRef }) {
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const name = img.path.split(/[\\/]/).pop() ?? img.path;
  const dims = img.width && img.height ? `${img.width}×${img.height}` : undefined;
  const { src, failed } = useAssetSrc(chatId, img);
  const broken = failed || decodeFailed;

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
      <figure className="overflow-hidden rounded-md border border-line bg-inset">
        {/* Nothing to enlarge until the bytes land — don't advertise a zoom
            affordance (or take focus) for a click that would do nothing. */}
        <button
          type="button"
          disabled={!src}
          onClick={() => setZoomed(true)}
          className={cn(
            "block w-full outline-none focus-visible:ring-1 focus-visible:ring-accent-line",
            src ? "cursor-zoom-in" : "cursor-default",
          )}
          title={src ? "Click to enlarge" : undefined}
        >
          {src ? (
            <img
              src={src}
              alt={img.alt ?? name}
              onError={() => setDecodeFailed(true)}
              className="block max-h-52 max-w-[240px] object-contain"
            />
          ) : (
            // The bytes are still being fetched. Hold the row's height so a
            // transcript doesn't jump as thumbnails resolve.
            <span className="block h-24 w-[160px] animate-pulse bg-panel-2" aria-hidden />
          )}
        </button>
        <figcaption className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1">
          <span className="truncate text-2xs text-secondary">{name}</span>
          {dims && <span className="cm-mono !text-2xs text-faint">{dims}</span>}
        </figcaption>
      </figure>
      {zoomed && src && (
        <ImageLightbox src={src} name={name} dims={dims} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}
