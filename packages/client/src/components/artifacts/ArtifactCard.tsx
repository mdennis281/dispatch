import { memo, useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { parseMcpToolName, type ArtifactRef, type ToolResultRow, type ToolUseRow } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";
import { useArtifactView } from "../../stores/artifacts.js";
import { RowShell } from "../chat/rows/RowShell.js";
import { RowButton } from "../ui/RowButton.js";
import { artifactIcon, artifactTypeLabel } from "./artifactIcon.js";

/**
 * A card opens itself only when its result is THIS fresh. Older than that it is
 * history being scrolled through or a transcript loading, and a pane springing
 * open over the chat you just navigated to would be the app acting on its own.
 */
const AUTO_OPEN_WINDOW_MS = 20_000;

/**
 * Versions that have already opened the pane once. A card can mount more than
 * once inside the window — a chat switch and back, a transcript page reload —
 * and re-opening a pane the human just closed would be the app overruling them.
 */
const autoOpened = new Set<string>();

/**
 * An `artifact_create` / `artifact_update` call in the transcript: a card that
 * opens the pane on the version the call produced. A call that is still
 * running or that failed is NOT this card — it stays the ordinary Dispatch tool
 * card, which already knows how to show both.
 */
export const ArtifactCard = memo(function ArtifactCard({
  use,
  result,
  artifact,
}: {
  use: ToolUseRow;
  result: ToolResultRow;
  artifact: ArtifactRef;
}) {
  const noteLatest = useArtifactView((s) => s.noteLatest);
  const openArtifact = useArtifactView((s) => s.openArtifact);
  const showing = useArtifactView(
    (s) => s.open?.chatId === use.chatId && s.open.id === artifact.id,
  );
  const latest = useArtifactView((s) => s.latest[`${use.chatId}:${artifact.id}`] ?? artifact.version);

  useEffect(() => {
    noteLatest(use.chatId, artifact.id, artifact.version);
    const fresh = Date.now() - (result.ts ?? 0) < AUTO_OPEN_WINDOW_MS;
    const key = `${use.chatId}:${artifact.id}:${artifact.version}`;
    if (fresh && !autoOpened.has(key) && !useArtifactView.getState().open) {
      autoOpened.add(key);
      openArtifact(use.chatId, artifact.id, null);
    }
  }, [use.chatId, artifact.id, artifact.version, result.ts, noteLatest, openArtifact]);

  const Icon = artifactIcon(artifact.type);
  const isLatest = artifact.version >= latest;
  const created = parseMcpToolName(use.name)?.tool === "artifact_create";

  return (
    <RowShell
      ts={result.ts}
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md text-accent-hi [&_svg]:size-3.5">
          <Icon />
        </span>
      }
    >
      <RowButton
        onClick={() => openArtifact(use.chatId, artifact.id, isLatest ? null : artifact.version)}
        className={cn(
          "group/artifact flex w-full max-w-md items-center gap-3 rounded-md border border-line bg-panel-2/60 px-3 py-2 text-left transition-colors hover:border-accent/60 hover:bg-hover/30",
          showing && "border-accent/60",
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line-soft bg-inset text-accent-hi [&_svg]:size-4">
          <Icon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-primary">{artifact.title}</span>
          <span className="block truncate text-xs text-muted">
            {artifactTypeLabel(artifact.type)} · {created ? "published" : "updated to"} v{artifact.version}
            {!isLatest && ` · newer: v${latest}`}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-hover/artifact:translate-x-0.5" />
      </RowButton>
    </RowShell>
  );
});
