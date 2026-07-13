import type { UserMessageRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { ImageThumb } from "./ImageThumb.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";

/** A user turn: avatar initial, text, attached image thumbnails, effort chip. */
export function UserRow({ chatId, row }: { chatId: string; row: UserMessageRow }) {
  const canRollback = useHasCheckpoint(chatId, row.id);
  return (
    <RowShell
      tint="user"
      align="right"
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
        <span className="flex size-6 items-center justify-center rounded-md bg-white/[0.14] text-[10px] font-semibold text-white ring-1 ring-white/20">
          M
        </span>
      }
    >
      {row.text && (
        <div className="inline-block max-w-full rounded-2xl rounded-tr-sm border border-white/10 bg-white/[0.09] px-3 py-1.5 text-left align-top text-[13px] leading-[1.6] text-white whitespace-pre-wrap">
          {row.text}
        </div>
      )}
      {row.images && row.images.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {row.images.map((img) => (
            <ImageThumb key={img.id} chatId={chatId} img={img} />
          ))}
        </div>
      )}
    </RowShell>
  );
}
