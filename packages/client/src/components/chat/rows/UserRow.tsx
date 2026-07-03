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
