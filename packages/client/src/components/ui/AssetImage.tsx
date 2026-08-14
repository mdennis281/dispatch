import type { ImageRef } from "@dispatch/shared";
import { useAssetSrc } from "../../lib/assetSrc.js";

/**
 * A plain `<img>` for a chat asset, resolved through {@link useAssetSrc} so the
 * authenticated `/api/chats/:id/assets/:name` endpoint is reachable (a bare
 * `src=` sends no bearer token and 401s). Renders nothing until the bytes land.
 *
 * For a captioned, zoomable thumbnail use `ImageThumb` instead — this is the
 * bare element, for places that already supply their own chrome.
 */
export function AssetImage({
  chatId,
  img,
  alt,
  className,
}: {
  chatId: string;
  img: ImageRef;
  alt?: string;
  className?: string;
}) {
  const { src } = useAssetSrc(chatId, img);
  if (!src) return <span className={className} aria-hidden />;
  return <img src={src} alt={alt ?? img.alt ?? "attachment"} className={className} />;
}
