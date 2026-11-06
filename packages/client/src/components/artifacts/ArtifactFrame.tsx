import { useEffect, useMemo, useRef } from "react";
import {
  ARTIFACT_SANDBOX,
  artifactBootMessage,
  asArtifactMessage,
  buildArtifactBundleDocument,
  buildArtifactDocument,
  type ArtifactBootAsset,
} from "../../lib/artifactDoc.js";

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
 *
 * With `assets`, the frame boots in two phases (see `ASSET_LOADER` in
 * lib/artifactDoc.ts): the srcdoc is only the loader, and the page and its
 * files are posted in when the loader says it is listening. Once per mount —
 * a second `boot-ready` from the same window is not a fresh frame, and
 * answering it would hand the page to whatever that window has become.
 */
export function ArtifactFrame({
  type,
  content,
  title,
  storage,
  assets,
  onError,
  onStorage,
}: {
  type: "html" | "svg";
  content: string;
  title: string;
  storage: Record<string, string>;
  /** The version's files, downloaded. Only for html. */
  assets?: ArtifactBootAsset[];
  /** A runtime error the frame reported. */
  onError: (message: string) => void;
  /** A `localStorage` write the frame made. */
  onStorage: (write: ArtifactStorageWrite) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const seed = useRef(storage);
  const bundled = !!assets;
  const doc = useMemo(
    () => (bundled ? buildArtifactBundleDocument(seed.current) : buildArtifactDocument(type, content, seed.current)),
    [type, content, bundled],
  );
  const boot = useRef({ content, assets, sent: false });
  boot.current = { ...boot.current, content, assets };
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
      else if (msg?.kind === "boot-ready") {
        const b = boot.current;
        if (!b.assets || b.sent) return;
        b.sent = true;
        // "*" because the frame's origin is opaque — there is no other target
        // that matches it. `source` above is what pins this to OUR frame.
        ref.current.contentWindow?.postMessage(artifactBootMessage(b.content, b.assets), "*");
      }
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
