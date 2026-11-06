import { useEffect } from "react";
import { cn } from "../../lib/cn.js";
import { useLayout } from "../../stores/layout.js";
import { useArtifactView } from "../../stores/artifacts.js";
import { RegionErrorBoundary } from "../ErrorBoundary.js";
import { ArtifactPane } from "./ArtifactPane.js";

/**
 * Where the artifact pane sits.
 *
 * At `lg` it is a column BESIDE the transcript, because the point of an
 * artifact is to look at it while talking about it — the right panel's 360px
 * is too narrow for a page, so it takes its own share of the width. "Expand"
 * lets it cover the transcript. Below `lg` there is no room to share, so it is
 * always a full sheet over the main area with a close button.
 *
 * Only ever shows an artifact of the chat on screen: switching chats with a
 * pane open closes it rather than leaving one chat's page beside another's
 * conversation.
 */
export function ArtifactPaneHost({ chatId }: { chatId: string }) {
  const open = useArtifactView((s) => s.open);
  const expanded = useArtifactView((s) => s.expanded);
  const close = useArtifactView((s) => s.close);
  const mode = useLayout((s) => s.mode);

  useEffect(() => {
    if (open && open.chatId !== chatId) close();
  }, [open, chatId, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (mode !== "lg" || expanded)) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mode, expanded, close]);

  if (!open || open.chatId !== chatId) return null;

  const sheet = mode !== "lg" || expanded;
  return (
    <section
      aria-label="Artifact"
      className={cn(
        "border-line bg-surface",
        sheet
          ? "absolute inset-0 z-30"
          : "relative w-[46%] min-w-[420px] max-w-[960px] shrink-0 border-l",
      )}
    >
      {/* Its own boundary: an artifact is arbitrary content from an agent, and
          a renderer that chokes on it must cost the pane, not the chat. */}
      <RegionErrorBoundary scope="artifact" resetKey={`${open.id}:${open.version ?? "latest"}`}>
        <ArtifactPane open={open} />
      </RegionErrorBoundary>
    </section>
  );
}
