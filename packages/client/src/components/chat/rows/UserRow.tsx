import { memo } from "react";
import type { UserMessageRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { ImageThumb } from "./ImageThumb.js";
import { ComposedParts } from "./ComposedParts.js";
import { actions } from "../../../lib/actions.js";
import { useHasCheckpoint } from "../../../stores/checkpoints.js";

/**
 * A user turn: avatar initial, text, attached image thumbnails, effort chip.
 *
 * A turn the APP composed (a launched task's briefing, or a plain message that
 * carried injected memory context) arrives with `parts` — an authorship
 * breakdown. Those render instead of the flat text, so the app's words are
 * quoted rather than passed off as typed; see ComposedParts. Rows written before
 * that existed have no `parts` and render exactly as they always did.
 */
export const UserRow = memo(function UserRow({
  chatId,
  row,
}: {
  chatId: string;
  row: UserMessageRow;
}) {
  const canRollback = useHasCheckpoint(chatId, row.id);
  const composed = row.parts && row.parts.length > 0 ? row.parts : null;
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
          {composed?.some((p) => p.kind === "brief") && <Chip tone="muted">composed</Chip>}
          {row.effort && <Chip tone="muted">{row.effort}</Chip>}
        </>
      }
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-bubble text-[10px] font-semibold text-primary ring-1 ring-bubble-line">
          M
        </span>
      }
    >
      {composed ? (
        <ComposedParts chatId={chatId} parts={composed} />
      ) : (
        row.text && (
          <div className="inline-block max-w-full rounded-2xl rounded-tr-sm border border-bubble-line bg-bubble px-3 py-1.5 text-left align-top text-[13px] leading-[1.6] text-primary whitespace-pre-wrap">
            {row.text}
          </div>
        )
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
});
