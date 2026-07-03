import { useState } from "react";
import { ImageIcon } from "lucide-react";
import type { ImageRef, UserMessageRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { actions, assetUrl } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";

/** One attached image — real thumbnail via the asset endpoint, card fallback. */
function ImageThumb({ chatId, img }: { chatId: string; img: ImageRef }) {
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

/** A user turn: avatar initial, text, attached image thumbnails, effort chip. */
export function UserRow({ chatId, row }: { chatId: string; row: UserMessageRow }) {
  const canRollback = useHasCheckpoint(chatId, row.id);
  return (
    <RowShell
      tint="user"
      who="You"
      ts={row.ts}
      rollback={canRollback}
      onRollback={() => actions.rollback(chatId, row.id)}
      meta={
        <>
          {row.steering && <Chip tone="accent">steering</Chip>}
          {row.effort && <Chip tone="muted">{row.effort}</Chip>}
        </>
      }
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-panel-2 text-[10px] font-semibold text-secondary ring-1 ring-line">
          M
        </span>
      }
    >
      {row.text && <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-primary/95">{row.text}</p>}
      {row.images && row.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {row.images.map((img) => (
            <ImageThumb key={img.id} chatId={chatId} img={img} />
          ))}
        </div>
      )}
    </RowShell>
  );
}
