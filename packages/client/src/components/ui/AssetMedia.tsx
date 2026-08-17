import { Download, FileIcon, Music } from "lucide-react";
import { type ImageRef, formatBytes, mediaKind } from "@dispatch/shared";
import { useAssetSrc } from "../../lib/assetSrc.js";

/**
 * A chat attachment that ISN'T an image — a video an MCP recorded, an audio
 * clip, a zip. Images keep going through `ImageThumb`, which has zoom and
 * lightbox behaviour none of these want.
 *
 * Everything resolves through {@link useAssetSrc}, which fetches with the
 * session's bearer token and hands back an object URL. A bare `src=` on
 * `/api/…` sends no token and 401s, and the service worker can't fix it.
 *
 * KNOWN LIMIT: that means the whole file is downloaded before playback starts,
 * so the server's range support doesn't shorten time-to-first-frame here (once
 * the blob exists the browser seeks within it locally, so scrubbing does work).
 * Fine for the short captures this exists for; a long video would want a
 * short-lived signed asset URL instead, which is real auth surface and belongs
 * in its own change rather than bolted onto this one.
 */
export function AssetMedia({
  chatId,
  asset,
  className,
}: {
  chatId: string;
  asset: ImageRef;
  className?: string;
}) {
  const { src, failed } = useAssetSrc(chatId, asset);
  const name = asset.alt ?? asset.path.split(/[\\/]/).pop() ?? asset.path;
  const kind = mediaKind(asset.mimeType);

  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1.5">
        <span className="text-muted [&_svg]:size-4" aria-hidden>
          <FileIcon />
        </span>
        <span className="text-xs text-secondary">{name} — could not load</span>
      </div>
    );
  }

  if (!src) {
    // Hold a stable height so the transcript doesn't jump as bytes resolve.
    return (
      <span
        className={className ?? "block h-24 w-[240px] animate-pulse rounded-md bg-panel-2"}
        aria-hidden
      />
    );
  }

  if (kind === "video") {
    return (
      <figure className="overflow-hidden rounded-md border border-line bg-inset">
        <video
          src={src}
          controls
          preload="metadata"
          className="block max-h-72 max-w-full bg-black"
        />
        <MediaCaption name={name} src={src} />
      </figure>
    );
  }

  if (kind === "audio") {
    return (
      <figure className="overflow-hidden rounded-md border border-line bg-inset">
        <span className="flex items-center gap-2 px-2 pt-2 text-muted [&_svg]:size-4" aria-hidden>
          <Music />
        </span>
        <audio src={src} controls className="block w-full max-w-[320px] px-2 py-1.5" />
        <MediaCaption name={name} src={src} />
      </figure>
    );
  }

  // Anything else: a download chip. An <a download> is the right primitive —
  // it needs no JS and gives the browser's own save affordance.
  return (
    <a
      href={src}
      download={name}
      className="inline-flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1.5 text-xs text-secondary outline-none hover:text-primary focus-visible:ring-1 focus-visible:ring-accent-line"
    >
      <span className="text-muted [&_svg]:size-4" aria-hidden>
        <Download />
      </span>
      <span className="truncate">{name}</span>
    </a>
  );
}

function MediaCaption({ name, src }: { name: string; src: string }) {
  return (
    <figcaption className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1">
      <span className="truncate text-2xs text-secondary">{name}</span>
      <a
        href={src}
        download={name}
        className="ml-auto shrink-0 text-2xs text-faint outline-none hover:text-secondary focus-visible:ring-1 focus-visible:ring-accent-line"
      >
        Download
      </a>
    </figcaption>
  );
}

/** Re-exported so call sites can size a placeholder without importing shared. */
export { formatBytes };
