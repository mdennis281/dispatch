import { AppWindow, Maximize2, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import {
  bringBackArtifact,
  focusArtifactWindow,
  openArtifactWindow,
} from "../../lib/artifactWindow.js";
import { artifactKey, useArtifactView, type OpenArtifact } from "../../stores/artifacts.js";
import { useNotices } from "../../stores/notices.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { ArtifactBody, ArtifactControls } from "./ArtifactViewer.js";
import { artifactIcon } from "./artifactIcon.js";
import { useArtifactDoc } from "./useArtifactDoc.js";

/**
 * The artifact pane: one artifact, one version at a time, previewed or as
 * source. Placement (beside the transcript at `lg`, over it below) is the
 * host's job — see {@link ArtifactPaneHost}.
 *
 * While the artifact is popped out into its own window this shows a
 * placeholder INSTEAD of a live view — it does not mount `useArtifactDoc` at
 * all, because a second live view would fight the window over the artifact's
 * persisted localStorage (see lib/artifactWindow).
 */
export function ArtifactPane({ open }: { open: OpenArtifact }) {
  const popped = useArtifactView((s) => s.popped[artifactKey(open.chatId, open.id)]);
  return popped ? <PoppedOut open={open} title={popped.title} /> : <LivePane open={open} />;
}

function LivePane({ open }: { open: OpenArtifact }) {
  const { chatId, id, version: pinned } = open;
  const expanded = useArtifactView((s) => s.expanded);
  const setExpanded = useArtifactView((s) => s.setExpanded);
  const openArtifact = useArtifactView((s) => s.openArtifact);
  const close = useArtifactView((s) => s.close);
  const doc = useArtifactDoc(chatId, id, pinned);
  const Icon = artifactIcon(doc.type ?? "html");

  const popOut = () => {
    if (!openArtifactWindow({ chatId, id, version: pinned }, doc.data?.meta.title)) {
      useNotices.getState().push({
        level: "error",
        text: "The browser blocked the new window — allow pop-ups for this site and try again.",
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span className="flex size-6 shrink-0 items-center justify-center text-accent-hi [&_svg]:size-3.5">
          <Icon />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary" title={doc.data?.meta.title}>
          {doc.data?.meta.title ?? "Artifact"}
        </span>
        <ArtifactControls doc={doc} onPickVersion={(v) => openArtifact(chatId, id, v)} />
        {/* Not on a phone: there `window.open` is just another tab, and the
            pane is already the whole screen. */}
        <IconButton tip="Open in window" onClick={popOut} className="max-sm:hidden">
          <SquareArrowOutUpRight />
        </IconButton>
        <IconButton tip={expanded ? "Restore" : "Expand"} onClick={() => setExpanded(!expanded)} className="max-lg:hidden">
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton tip="Close" onClick={close}>
          <X />
        </IconButton>
      </div>
      <ArtifactBody doc={doc} />
    </div>
  );
}

function PoppedOut({ open, title }: { open: OpenArtifact; title: string | undefined }) {
  const close = useArtifactView((s) => s.close);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span className="flex size-6 shrink-0 items-center justify-center text-muted [&_svg]:size-3.5">
          <AppWindow />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary" title={title}>
          {title ?? "Artifact"}
        </span>
        <IconButton tip="Close" onClick={close}>
          <X />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-lg border border-line bg-panel-2 text-accent-hi [&_svg]:size-6">
          <AppWindow />
        </span>
        <div>
          <p className="text-sm font-semibold text-primary">Open in a separate window</p>
          <p className="mt-1 max-w-xs text-xs text-muted">
            {title ? <>&ldquo;{title}&rdquo; is</> : "This artifact is"} running in its own window. It
            shows here again when that window closes.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => focusArtifactWindow(open.chatId, open.id)}>
            Focus window
          </Button>
          <Button size="sm" onClick={() => bringBackArtifact(open.chatId, open.id)}>
            Bring back
          </Button>
        </div>
      </div>
    </div>
  );
}
