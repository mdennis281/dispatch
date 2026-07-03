import { useState } from "react";
import { ImageIcon } from "lucide-react";
import type { ImageRef } from "@cm/shared";
import { assetUrl } from "../../../lib/actions.js";

/**
 * One image thumbnail — a real preview via the chat's asset endpoint with a
 * labelled card fallback if the bytes can't load. Shared by the user turn
 * (pasted/dropped attachments) and the tool card (images a tool returned, e.g.
 * a Claude-in-Chrome screenshot).
 */
export function ImageThumb({ chatId, img }: { chatId: string; img: ImageRef }) {
  const [broken, setBroken] = useState(false);
  const name = img.path.split(/[\\/]/).pop() ?? img.path;
  const dims = img.width && img.height ? `${img.width}×${img.height}` : undefined;

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
          <div className="text-[11.5px] text-secondary">{name}</div>
          {dims && <div className="cm-mono !text-[10px] text-faint">{dims}</div>}
        </div>
      </div>
    );
  }

  return (
    <figure className="overflow-hidden rounded-md border border-line bg-inset">
      <img
        src={assetUrl(chatId, img)}
        alt={img.alt ?? name}
        loading="lazy"
        onError={() => setBroken(true)}
        className="block max-h-52 max-w-[240px] object-contain"
      />
      <figcaption className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1">
        <span className="truncate text-[10.5px] text-secondary">{name}</span>
        {dims && <span className="cm-mono !text-[10px] text-faint">{dims}</span>}
      </figcaption>
    </figure>
  );
}
