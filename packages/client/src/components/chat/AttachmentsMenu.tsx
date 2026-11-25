import { useState, type ReactNode } from "react";
import { FileIcon, Images, Music, Paperclip, Play, Sparkles } from "lucide-react";
import { mediaKind, type ArtifactMeta, type ChatMediaItem } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";
import { relTime } from "../../lib/format.js";
import {
  attachmentCount,
  useChatAttachments,
  type AttachmentKind,
  type ChatAttachments,
} from "../../lib/chatAttachments.js";
import { useArtifactView } from "../../stores/artifacts.js";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl, type Segment } from "../ui/SegmentedControl.js";
import { AssetImage } from "../ui/AssetImage.js";
import { artifactIcon, artifactTypeLabel } from "../artifacts/artifactIcon.js";
import { MediaViewer, assetName } from "./rows/MediaViewer.js";

type Filter = "all" | AttachmentKind;

/**
 * How each kind presents itself. The ONE place a new kind is described — its
 * label, its glyph, how many it has — so a fourth kind is a row here and a
 * section renderer below, and the filter and the sections pick it up.
 */
const KINDS: Record<AttachmentKind, { label: string; icon: ReactNode }> = {
  artifacts: { label: "Artifacts", icon: <Sparkles /> },
  images: { label: "Images", icon: <Images /> },
  files: { label: "Files", icon: <FileIcon /> },
};
const ORDER: AttachmentKind[] = ["artifacts", "images", "files"];

/**
 * In "All", the image grid stops at two full rows and the last tile opens the
 * rest. Two ROWS rather than a fixed count, so a phone's three columns don't
 * end on a ragged row of one.
 */
const allImageCap = (compact: boolean) => (compact ? 6 : 8);

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 pt-2 first:pt-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-faint">{label}</p>
      <span className="h-px flex-1 bg-line" />
      <span className="cm-mono !text-2xs tabular-nums text-muted">{count}</span>
    </div>
  );
}

function ArtifactRows({
  artifacts,
  compact,
  onOpen,
}: {
  artifacts: ArtifactMeta[];
  compact: boolean;
  onOpen: (a: ArtifactMeta) => void;
}) {
  return (
    <>
      {artifacts.map((a) => {
        const Icon = artifactIcon(a.type);
        const versions = a.versions.length;
        return (
          <MenuItem
            key={a.id}
            dense={!compact}
            title={`${a.title} — ${artifactTypeLabel(a.type, a.language)}`}
            // Expired is said, not hidden: the transcript still names it, and a
            // page that vanished from this list would look like a lost one.
            hint={a.expiredAt ? "expired" : `${versions > 1 ? `v${versions} · ` : ""}${relTime(a.updatedAt)}`}
            icon={<Icon className={a.expiredAt ? "text-faint" : "text-accent-2"} />}
            className={cn(a.expiredAt && "text-muted")}
            onClick={() => onOpen(a)}
          >
            {a.title}
          </MenuItem>
        );
      })}
    </>
  );
}

/**
 * A contact sheet, not a list. You recognise a screenshot by looking at it;
 * its content-addressed filename says nothing, so a list of names would be the
 * worst way to find one.
 */
function ImageGrid({
  chatId,
  items,
  cap,
  compact,
  onOpen,
  onMore,
}: {
  chatId: string;
  items: ChatMediaItem[];
  cap?: number;
  compact: boolean;
  onOpen: (item: ChatMediaItem) => void;
  onMore: () => void;
}) {
  const overflow = cap !== undefined && items.length > cap;
  // The last slot becomes the "+N" so the grid never grows a ragged extra row
  // just to say there is more.
  const shown = overflow ? items.slice(0, cap - 1) : items;
  return (
    <div className={cn("grid gap-1.5 p-1", compact ? "grid-cols-3" : "grid-cols-4")}>
      {shown.map((item) => {
        const video = mediaKind(item.asset.mimeType) === "video";
        const name = assetName(item.asset);
        return (
          <button
            key={item.asset.path}
            onClick={() => onOpen(item)}
            title={item.from === "user" ? `${name} · from you` : name}
            aria-label={name}
            className="group relative aspect-square overflow-hidden rounded-md border border-line bg-inset outline-none transition-colors hover:border-line-strong focus-visible:border-accent-line"
          >
            {video ? (
              <span className="flex size-full items-center justify-center text-muted [&_svg]:size-5">
                <Play />
              </span>
            ) : (
              <AssetImage
                chatId={chatId}
                img={item.asset}
                alt={name}
                className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
              />
            )}
            {/* The one bit of provenance worth a mark: your own paste among
                forty agent screenshots is the needle people come looking for. */}
            {item.from === "user" && (
              <span className="absolute bottom-1 left-1 rounded-sm bg-app/80 px-1 text-[10px] font-medium leading-4 text-secondary backdrop-blur-sm">
                You
              </span>
            )}
          </button>
        );
      })}
      {overflow && (
        <button
          onClick={onMore}
          className="flex aspect-square items-center justify-center rounded-md border border-line bg-inset text-sm font-medium tabular-nums text-muted transition-colors hover:border-line-strong hover:text-primary"
        >
          +{items.length - shown.length}
        </button>
      )}
    </div>
  );
}

function FileRows({
  items,
  compact,
  onOpen,
}: {
  items: ChatMediaItem[];
  compact: boolean;
  onOpen: (item: ChatMediaItem) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <MenuItem
          key={item.asset.path}
          dense={!compact}
          title={item.asset.path}
          hint={item.from === "user" ? "you" : undefined}
          icon={mediaKind(item.asset.mimeType) === "audio" ? <Music /> : <FileIcon />}
          onClick={() => onOpen(item)}
        >
          {assetName(item.asset)}
        </MenuItem>
      ))}
    </>
  );
}

function Empty({ ready }: { ready: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
      <Paperclip className="mb-1 size-4 text-faint" />
      <p className="text-sm text-secondary">{ready ? "Nothing here yet" : "Loading…"}</p>
      {ready && (
        <p className="text-xs leading-5 text-muted">
          Artifacts, images and files — from you or the agent — collect here.
        </p>
      )}
    </div>
  );
}

function Panel({
  chatId,
  groups,
  ready,
  compact,
  onArtifact,
  onMedia,
}: {
  chatId: string;
  groups: ChatAttachments;
  ready: boolean;
  compact: boolean;
  onArtifact: (a: ArtifactMeta) => void;
  onMedia: (item: ChatMediaItem) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const present = ORDER.filter((k) => groups[k].length > 0);
  if (present.length === 0) return <Empty ready={ready} />;

  // A filter over ONE kind is a control that does nothing, so it only appears
  // once there is something to choose between. A filter left pointing at a
  // kind that has since emptied falls back to everything.
  const active: Filter = filter !== "all" && groups[filter].length > 0 ? filter : "all";
  const showFilter = present.length > 1;
  const segments: Segment<Filter>[] = [
    { value: "all", label: "All" },
    ...present.map((k) => ({
      value: k,
      label: KINDS[k].label,
      badge: (
        <span className="cm-mono !text-2xs tabular-nums text-faint">{groups[k].length}</span>
      ),
    })),
  ];
  const visible = active === "all" ? present : [active];

  const section = (k: AttachmentKind) => {
    if (k === "artifacts")
      return <ArtifactRows artifacts={groups.artifacts} compact={compact} onOpen={onArtifact} />;
    if (k === "images")
      return (
        <ImageGrid
          chatId={chatId}
          items={groups.images}
          cap={active === "all" ? allImageCap(compact) : undefined}
          compact={compact}
          onOpen={onMedia}
          onMore={() => setFilter("images")}
        />
      );
    return <FileRows items={groups.files} compact={compact} onOpen={onMedia} />;
  };

  return (
    <div className="flex flex-col">
      {showFilter && (
        <div className="px-1 pb-1 pt-0.5">
          <SegmentedControl
            segments={segments}
            value={active}
            onChange={setFilter}
            size={compact ? "md" : "sm"}
            className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
          />
        </div>
      )}
      {visible.map((k) => (
        <div key={k} className="flex flex-col">
          {/* Under a single-kind filter the segment already names it. */}
          {(active === "all" || !showFilter) && (
            <SectionHead label={KINDS[k].label} count={groups[k].length} />
          )}
          {section(k)}
        </div>
      ))}
    </div>
  );
}

/**
 * The chat's attachments, behind a paperclip at the head of the title bar.
 *
 * WHY IT EXISTS: an artifact or a screenshot is the most valuable thing a chat
 * produces and the hardest to get back to — it is a card somewhere in a
 * transcript that pages in 150 rows at a time. This is the shelf they all land
 * on, whatever turn made them.
 *
 * The count rides on the trigger, so "did this chat make anything?" is answered
 * without a click; with nothing to show the trigger fades rather than vanishes,
 * because a title that shifts sideways when the first image lands is worse
 * than a faint glyph.
 */
export function AttachmentsMenu({ chatId, compact }: { chatId: string; compact: boolean }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const openArtifact = useArtifactView((s) => s.openArtifact);
  const { ready, groups, gallery, refresh } = useChatAttachments(chatId);
  const total = attachmentCount(groups);

  return (
    <>
      <Popover
        align="start"
        width={compact ? 320 : 380}
        className="p-1.5"
        trigger={({ open: isOpen, toggle }) => {
          return (
            <Button
              variant="ghost"
              size={compact ? "md" : "sm"}
              onClick={() => {
                if (!isOpen) refresh();
                toggle();
              }}
              aria-expanded={isOpen}
              aria-label={total > 0 ? `Attachments (${total})` : "Attachments"}
              title="Attachments"
              className={cn(
                "-ml-1.5 shrink-0 gap-1 px-1.5",
                total === 0 && !isOpen && "text-faint",
                isOpen && "bg-active text-primary",
              )}
            >
              <Paperclip className="size-3.5" />
              {total > 0 && (
                <span className="cm-mono !text-2xs tabular-nums text-muted">{total}</span>
              )}
            </Button>
          );
        }}
      >
        {(_close, closeAfter) => (
          <Panel
            chatId={chatId}
            groups={groups}
            ready={ready}
            compact={compact}
            onArtifact={(a) => closeAfter(() => openArtifact(chatId, a.id, null))}
            onMedia={(item) => closeAfter(() => setViewing(item.asset.path))}
          />
        )}
      </Popover>
      {viewing !== null && (
        <MediaViewer
          chatId={chatId}
          assets={gallery.map((item) => item.asset)}
          path={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
