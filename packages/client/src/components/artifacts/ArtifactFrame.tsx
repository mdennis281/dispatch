import { useEffect, useMemo, useRef } from "react";
import { ARTIFACT_SANDBOX, asArtifactMessage, buildArtifactDocument } from "../../lib/artifactDoc.js";

export interface ArtifactStorageWrite {
  clear?: true;
  set: Record<string, string | null>;
}

/**
 * An html/svg artifact in its sandbox. See lib/artifactDoc.ts for why the
 * sandbox is shaped the way it is — the two attributes below are the boundary
 * between agent-written script and the Dispatch API, and must not change
 * without reading it.
 *
 * `storage` is read ONCE, when the frame mounts. The page owns its storage from
 * then on and reports every change through `onStorage`; feeding those changes
 * back in as a new prop would rebuild the `srcdoc` and reload the page on every
 * `setItem`. The pane keys this component on version + reload, so a remount —
 * which is the only time a fresh snapshot is wanted — gets the current one.
 */
export function ArtifactFrame({
  type,
  content,
  title,
  storage,
  onError,
  onStorage,
}: {
  type: "html" | "svg";
  content: string;
  title: string;
  storage: Record<string, string>;
  /** A runtime error the frame reported. */
  onError: (message: string) => void;
  /** A `localStorage` write the frame made. */
  onStorage: (write: ArtifactStorageWrite) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const seed = useRef(storage);
  const doc = useMemo(() => buildArtifactDocument(type, content, seed.current), [type, content]);
  const handlers = useRef({ onError, onStorage });
  handlers.current = { onError, onStorage };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // `source`, not `origin`: a sandboxed frame's origin is the string "null",
      // which every other sandboxed frame on the page shares. Its window is the
      // only thing that says THIS frame sent it — and that matters more now that
      // a message can write to the artifact's saved storage.
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const msg = asArtifactMessage(e.data);
      if (msg?.kind === "error") handlers.current.onError(msg.message);
      else if (msg?.kind === "storage") {
        handlers.current.onStorage(msg.clear ? { clear: true, set: msg.set } : { set: msg.set });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox={ARTIFACT_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      className="size-full border-0 bg-white"
    />
  );
}
