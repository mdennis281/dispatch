import { type ImageRef, mediaKind } from "@dispatch/shared";
import { ImageThumb } from "./ImageThumb.js";
import { AssetMedia } from "../../ui/AssetMedia.js";

/**
 * One attachment on a turn, rendered as whatever it actually is.
 *
 * Chats used to carry only images, so both the user turn and the tool card
 * reached straight for `ImageThumb`. Now an MCP can hand back a video or an
 * arbitrary file, and `mimeType` is what tells them apart — so the choice lives
 * in one place instead of being repeated (and half-updated) at each call site.
 *
 * `onOpen` comes from {@link MediaGroup}, which owns the viewer for the whole
 * row so that ← / → can step between siblings. Without it each thumbnail falls
 * back to opening a viewer of its own — still correct, just not a gallery.
 */
export function Attachment({
  chatId,
  asset,
  onOpen,
}: {
  chatId: string;
  asset: ImageRef;
  onOpen?: () => void;
}) {
  const kind = mediaKind(asset.mimeType);
  // Video goes through the viewer too — full-screen with the same download and
  // open-in-tab controls, rather than a 240px inline player and nothing else.
  return kind === "image" ? (
    <ImageThumb chatId={chatId} img={asset} onOpen={onOpen} />
  ) : (
    <AssetMedia chatId={chatId} asset={asset} onOpen={kind === "video" ? onOpen : undefined} />
  );
}
