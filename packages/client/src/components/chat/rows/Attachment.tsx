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
 */
export function Attachment({ chatId, asset }: { chatId: string; asset: ImageRef }) {
  return mediaKind(asset.mimeType) === "image" ? (
    <ImageThumb chatId={chatId} img={asset} />
  ) : (
    <AssetMedia chatId={chatId} asset={asset} />
  );
}
