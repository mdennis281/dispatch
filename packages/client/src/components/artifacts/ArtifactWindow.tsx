/**
 * ArtifactWindow — one artifact in a window of its own. `main.tsx` mounts this
 * INSTEAD of the app when the URL carries `?artifact=<chatId>/<artifactId>`
 * (optionally `&v=<n>` to pin a version), the same way `?logs=` mounts
 * RunnerLogWindow: same bundle, same origin, same auth, none of the shell.
 *
 * It is a full live view — the same `useArtifactDoc` the pane uses, so Reload,
 * the version picker, persisted storage and error reporting behave exactly as
 * they do beside the chat. While it is open, the app's pane for this artifact
 * is a placeholder (see lib/artifactWindow for why there is only ever one).
 *
 * Opened with a featureless `window.open` from the installed app, it is a full
 * app window and honours the manifest's `display_override` — so it can have
 * the window controls overlay, and then its toolbar IS the title bar (see
 * `artifactWindowFeatures` for what Chromium's source says about that).
 *
 * Live updates: this window has no transcript, so the transcript cards that
 * feed `noteLatest` in the app never render here, and its zustand store is
 * its own. Two things feed it instead: the app relays every newer version it
 * sees over the window channel (`latest`, see lib/artifactWindow), and the
 * window's own socket (main.tsx starts live data for it, as for the log
 * window) delivers any server-side artifact event the store reduces into
 * `noteLatest`. Either moves `useArtifactDoc`'s `latest` and refetches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import {
  artifactWindowUrl,
  joinArtifactWindowChannel,
  parseArtifactWindowParams,
} from "../../lib/artifactWindow.js";
import { useWindowControlsOverlay } from "../../lib/windowControls.js";
import { ArtifactBody, ArtifactControls, Notice } from "./ArtifactViewer.js";
import { artifactIcon } from "./artifactIcon.js";
import { useArtifactDoc } from "./useArtifactDoc.js";

export function ArtifactWindow() {
  const target = useMemo(() => parseArtifactWindowParams(location.search), []);
  if (!target) {
    return (
      <div className="flex h-dvh flex-col bg-surface text-primary">
        <Notice tone="danger">This window&rsquo;s address doesn&rsquo;t name an artifact.</Notice>
      </div>
    );
  }
  return <ArtifactWindowView chatId={target.chatId} id={target.id} initialVersion={target.version} />;
}

function ArtifactWindowView({
  chatId,
  id,
  initialVersion,
}: {
  chatId: string;
  id: string;
  initialVersion: number | null;
}) {
  const [pinned, setPinned] = useState<number | null>(initialVersion);
  /**
   * Set when the app asked for the artifact back. The body unmounts first so
   * the page stops writing; then the last write is awaited, and only then is
   * the app told it may go live — the reverse order hands the pane a storage
   * snapshot from before the page's final save.
   */
  const [returning, setReturning] = useState(false);
  const [stuck, setStuck] = useState(false);
  const wco = useWindowControlsOverlay();
  const doc = useArtifactDoc(chatId, id, pinned);
  const title = doc.data?.meta.title;
  const shown = doc.data?.version;
  const Icon = artifactIcon(doc.type ?? "html");

  const presence = useRef<ReturnType<typeof joinArtifactWindowChannel> | null>(null);
  useEffect(() => {
    const p = joinArtifactWindowChannel(chatId, id, { onBringBack: () => setReturning(true) });
    presence.current = p;
    return () => p.dispose();
  }, [chatId, id]);
  useEffect(() => {
    presence.current?.announce({
      ...(title !== undefined ? { title } : {}),
      ...(shown !== undefined ? { version: shown } : {}),
    });
  }, [title, shown]);

  const settle = doc.storage.settle;
  useEffect(() => {
    if (!returning) return;
    let live = true;
    void settle().then(() => {
      if (!live) return;
      presence.current?.leave(true);
      window.close();
      // Only a window a script opened may close itself. One reached by
      // pasting the URL stays open — say so instead of looking frozen.
      window.setTimeout(() => live && setStuck(true), 300);
    });
    return () => {
      live = false;
    };
  }, [returning, settle]);

  // The OS window and taskbar entry are the only places this window's name
  // shows, and with the overlay up there is no title bar to show it at all.
  useEffect(() => {
    document.title = title ? `${title}${shown ? ` · v${shown}` : ""} — Dispatch` : "Artifact — Dispatch";
  }, [title, shown]);

  // The pinned version lives in the URL too, so reloading this window (or
  // its being restored by the OS) brings back the version you were on.
  const pickVersion = (v: number | null) => {
    setPinned(v);
    history.replaceState(null, "", artifactWindowUrl({ chatId, id, version: v }, location.origin));
  };

  return (
    <div className="flex h-dvh flex-col bg-surface text-primary">
      <header
        className={cn(
          "flex shrink-0 border-b border-line bg-surface",
          // With the overlay the bar is the window's handle: drag everywhere,
          // controls carved out by `.cm-titlebar`'s element rule. Without it
          // the OS has a title bar already, and this is one slim toolbar row.
          wco ? "cm-titlebar cm-artifact-titlebar" : "px-2 [--ab-line:2.5rem]",
        )}
      >
        {/* Two groups that WRAP rather than squeeze: when the band is too
            narrow for title and controls side by side (a ~560px window loses
            262px of it to the buttons), the controls drop to a second line
            instead of sliding under the window buttons. Each line is one
            `--ab-line` tall, so line one stays centred on the buttons. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden">
          <div className="flex h-(--ab-line) min-w-0 flex-[1_1_8rem] items-center gap-1.5">
            <span className="flex size-6 shrink-0 items-center justify-center text-accent-hi [&_svg]:size-3.5">
              <Icon />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary" title={title}>
              {title ?? "Artifact"}
            </span>
          </div>
          {!returning && (
            <div className="ml-auto flex min-h-(--ab-line) flex-wrap items-center justify-end gap-1.5">
              <ArtifactControls doc={doc} onPickVersion={pickVersion} />
            </div>
          )}
        </div>
      </header>
      {returning ? (
        <Notice>{stuck ? "Back in the app — you can close this window." : "Returning to the app…"}</Notice>
      ) : (
        <ArtifactBody doc={doc} />
      )}
    </div>
  );
}
