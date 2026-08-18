import { Children, Fragment, createContext, useContext, useState, type ReactNode } from "react";
import { Film, ImageIcon, Music } from "lucide-react";
import {
  isPreviewablePath,
  mediaKind,
  mediaTypeFromPath,
  type ImageRef,
} from "@dispatch/shared";
import { fsImageRef } from "../../lib/assetSrc.js";
import { InlineChip } from "../ui/InlineChip.js";
import { MediaViewer } from "./rows/MediaViewer.js";
import { ImageThumb } from "./rows/ImageThumb.js";

/**
 * Media an assistant referred to by PATH, made visible.
 *
 * The most common way an image reaches a human is the one nothing handled: the
 * agent runs a script, the script writes `out/chart.png`, and the agent then
 * either embeds it as `![chart](out/chart.png)` or just names it in a sentence.
 * No bytes crossed the wire, so the asset pipeline never saw it. The markdown
 * renderer emitted `<img src="out/chart.png">`, which resolves against the SPA
 * origin, 404s, and paints the broken-image glyph.
 *
 * Two treatments, because the two mentions mean different things:
 *
 *   • Explicit `![…](path)` — the agent asked for a picture. Render one.
 *   • A path merely MENTIONED in prose — the agent was talking about a file.
 *     Render a chip, which expands on click. A transcript that edits a dozen
 *     PNGs would be unreadable as a dozen thumbnails, but a dozen inline chips
 *     read like the filenames they replaced.
 *
 * Both resolve through `fsImageRef`, which routes to the confined `fs-asset`
 * endpoint — see `services/fs-assets.ts` for what that will and won't serve.
 */

/** The chat whose worktree a bare path should resolve against. */
export const MediaRefContext = createContext<string | null>(null);

/** Everything a mention needs to become a viewable ref. */
function refFor(path: string): ImageRef {
  return fsImageRef(path, { mimeType: mediaTypeFromPath(path) });
}

const KIND_ICON = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  file: ImageIcon,
} as const;

/**
 * An inline chip for a media file named in prose. Click expands it in the
 * viewer — the same one a thumbnail opens, so zoom/copy/download all apply.
 */
export function MediaRefChip({ chatId, path }: { chatId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const asset = refFor(path);
  const Icon = KIND_ICON[mediaKind(asset.mimeType)];
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <>
      <InlineChip onClick={() => setOpen(true)} title={`Preview ${path}`} icon={<Icon />}>
        {name}
      </InlineChip>
      {open && (
        <MediaViewer chatId={chatId} assets={[asset]} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * A markdown `![alt](src)`, resolved to something that actually renders.
 *
 * `data:` and `http(s):` pass through untouched; anything else is treated as a
 * path in the chat's working tree. Falls back to a plain `<img>` when there is
 * no chat in scope (a preview pane, a test) rather than rendering nothing.
 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const chatId = useContext(MediaRefContext);
  if (!src) return null;

  const direct = /^(https?:|data:|blob:)/i.test(src);
  if (!chatId) {
    return <img src={src} alt={alt ?? ""} className="my-2 max-h-80 max-w-full rounded-md" />;
  }
  // A direct URL still goes through ImageThumb, so it gets the same caption,
  // checkerboard and click-to-zoom as every other image in the transcript.
  const asset: ImageRef = direct
    ? { id: `md-${src}`, path: src, mimeType: mediaTypeFromPath(src), alt }
    : refFor(stripRelative(src));
  return (
    <span className="my-2 block">
      <ImageThumb chatId={chatId} img={{ ...asset, alt: alt || asset.alt }} />
    </span>
  );
}

/**
 * Drop a leading `./`, and any `<repo>/`-style prefix the agent added for the
 * reader's benefit. The server resolves relative to the chat's worktree, so
 * `./out/x.png` and `out/x.png` are the same file and only one of them works
 * as written.
 */
function stripRelative(src: string): string {
  return src.replace(/^\.\//, "");
}

/**
 * A path token in prose that is worth previewing.
 *
 * Requires a real extension and no scheme. Unlike the code-pointer regex next
 * door this does NOT require a line number — a media file is never referenced
 * with one — so the extension whitelist is doing all the work of keeping this
 * from firing on ordinary words.
 */
const MEDIA_PATH_RE = /(?:[\w.@~-]+[/\\])*[\w.@~-]*[\w@~-]\.[A-Za-z][A-Za-z0-9]{0,4}\b/g;

/**
 * Split one plain-text string into text + media chips.
 *
 * Mirrors `linkifyCodeRefs`, and runs after it: a token can be a code pointer
 * or a media path, never both, because the extension sets are disjoint.
 */
export function linkifyMediaRefs(text: string, chatId: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(MEDIA_PATH_RE)) {
    const idx = m.index ?? 0;
    const full = m[0];
    if (!isPreviewablePath(full)) continue;
    // A path immediately preceded by `/` or a word character is the tail of a
    // longer token the regex clipped — not something to link on its own.
    const before = text[idx - 1];
    if (before && /[\w/\\:.-]/.test(before)) continue;
    if (idx > last) out.push(text.slice(last, idx));
    out.push(<MediaRefChip key={`mr${key++}`} chatId={chatId} path={full} />);
    last = idx + full.length;
  }
  if (out.length === 0) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Linkify media paths in the STRING leaves of a rendered children tree.
 *
 * Deliberately does not descend into element children, matching
 * `linkifyChildren` next door: every prose element that can contain nested
 * elements (`p`, `li`, `strong`, `em`, `h1..3`, `blockquote`, `td`, `th`)
 * renders its own `<Linkify>`, so a path inside a `<strong>` is already reached
 * when that `<strong>` renders. Recursing here would visit it a second time.
 *
 * Leaving elements untouched is also what lets a chip the code-ref pass just
 * inserted survive this one.
 */
export function linkifyMediaChildren(children: ReactNode, chatId: string): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child === "string") {
      const parts = linkifyMediaRefs(child, chatId);
      return parts.length === 1 && typeof parts[0] === "string" ? (
        child
      ) : (
        <Fragment key={`m${i}`}>{parts}</Fragment>
      );
    }
    return child;
  });
}
