import { useEffect, useMemo, useRef } from "react";
import { ARTIFACT_SANDBOX, asArtifactMessage, buildArtifactDocument } from "../../lib/artifactDoc.js";

/**
 * An html/svg artifact in its sandbox. See lib/artifactDoc.ts for why the
 * sandbox is shaped the way it is — the two attributes below are the boundary
 * between agent-written script and the Dispatch API, and must not change
 * without reading it.
 */
export function ArtifactFrame({
  type,
  content,
  title,
  onError,
}: {
  type: "html" | "svg";
  content: string;
  title: string;
  /** A runtime error the frame reported. */
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => buildArtifactDocument(type, content), [type, content]);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // `source`, not `origin`: a sandboxed frame's origin is the string "null",
      // which every other sandboxed frame on the page shares. Its window is the
      // only thing that says THIS frame sent it.
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const msg = asArtifactMessage(e.data);
      if (msg) report.current(msg.message);
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
