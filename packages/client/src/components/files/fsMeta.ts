/**
 * How a filesystem entry LOOKS: its icon, and the human forms of its numbers.
 *
 * Split out from the two surfaces because a `.tsx` file that shows one icon in
 * the modal and a different one on the page is a file the user has to identify
 * twice, and because the formatting is the part worth testing without a DOM.
 */
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderGit2,
  HardDrive,
  Home,
  GitBranch,
  Link2Off,
  Lock,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { FsEntry, FsPlatform, FsRoot } from "@dispatch/shared";

/**
 * Extension → icon. Grouped by what the file IS to a person rather than by
 * format family: a `.ts` and a `.py` get the same icon because "this is code"
 * is the distinction that helps you find things in a list, and no icon set has
 * enough shapes to make forty languages individually recognizable at 14px.
 */
const BY_EXT: Record<string, LucideIcon> = {};
const assign = (icon: LucideIcon, exts: string[]) => {
  for (const e of exts) BY_EXT[e] = icon;
};

assign(FileCode, [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "swift", "php", "sh", "bash", "ps1", "sql",
  "html", "css", "scss", "vue", "svelte", "lua", "r", "pl",
]);
assign(Settings2, ["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "env", "properties"]);
assign(FileText, ["md", "mdx", "txt", "rst", "log", "rtf", "doc", "docx", "pdf", "tex"]);
assign(FileImage, ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tiff", "heic", "psd"]);
assign(FileVideo, ["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v"]);
assign(FileAudio, ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus"]);
assign(FileArchive, ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "iso", "dmg", "tgz", "zst"]);
assign(FileSpreadsheet, ["csv", "tsv", "xls", "xlsx", "ods", "parquet"]);

/** Directory names with a meaning worth showing at a glance. */
const BY_DIR_NAME: Record<string, LucideIcon> = {
  ".git": FolderGit2,
  ".worktrees": GitBranch,
};

/** The icon for one row. */
export function entryIcon(entry: Pick<FsEntry, "name" | "kind" | "ext" | "link">): LucideIcon {
  // A broken link is the one case where WHAT it points at matters more than
  // what it's called — the name still looks like an ordinary file.
  if (entry.link?.broken) return Link2Off;
  if (entry.kind === "directory") return BY_DIR_NAME[entry.name] ?? Folder;
  return BY_EXT[entry.ext] ?? File;
}

/** The icon for a root in the sidebar. */
export function rootIcon(root: Pick<FsRoot, "kind">): LucideIcon {
  switch (root.kind) {
    case "home":
      return Home;
    case "project":
      return FolderGit2;
    case "worktree":
      return GitBranch;
    default:
      return HardDrive;
  }
}

/** An unreadable row gets a padlock in place of its type icon. */
export const UNREADABLE_ICON = Lock;

/**
 * Bytes as a person reads them: `840 B`, `12.4 KB`, `1.2 GB`.
 *
 * Base 1024 with the short (KB/MB) labels, because that's what Windows Explorer
 * and every file manager on Linux show — being technically correct with KiB
 * here would mean the number in this app disagrees with the number in the OS's
 * own properties dialog for the same file.
 *
 * One decimal place below 10 and none above, so the column stays narrow without
 * rounding 1.9 GB to 2 GB.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A timestamp for a dense table column: a clock for today, a day and month for
 * this year, and a year for anything older.
 *
 * The point is that the leading characters differ between recent and old files,
 * so "what changed today" is answerable by glancing down the column rather than
 * by reading every date in full.
 */
export function formatStamp(ms: number | null, now = Date.now()): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  const nd = new Date(now);
  const sameDay =
    d.getFullYear() === nd.getFullYear() &&
    d.getMonth() === nd.getMonth() &&
    d.getDate() === nd.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === nd.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "18.2 GB free of 931 GB" for a drive row, or null when unmeasurable. */
export function formatCapacity(
  freeBytes: number | null | undefined,
  totalBytes: number | null | undefined,
): string | null {
  if (!totalBytes || freeBytes === null || freeBytes === undefined) return null;
  return `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`;
}

/**
 * A wire path in the separators the SERVER's own shell and tools use.
 *
 * Everything crossing the wire is forward-slashed, which is right for display
 * and for comparison but not always for INSERTION: a path handed to an agent
 * ends up in shell commands and tool calls on that machine, and the composer's
 * picker has always inserted the native form. Windows tolerates `/` in most
 * places and not all of them, so this keeps the paths people paste identical to
 * the ones they'd get from Explorer.
 */
export function fsToNative(path: string, platform: FsPlatform): string {
  return platform === "win32" ? path.replace(/\//g, "\\") : path;
}

/**
 * What a picker is asking for, as a sentence: "Choose a folder",
 * "Choose one or more PNG or JPG files".
 *
 * The rules are otherwise invisible until you click something that turns out to
 * be un-selectable, at which point the UI has taught you a rule by refusing you.
 */
export function describeFilter(filter: {
  select: "file" | "directory" | "any";
  extensions?: string[];
  multiple: boolean;
}): string {
  const many = filter.multiple;
  const exts = filter.extensions?.filter(Boolean).map((e) => e.toUpperCase());
  // The noun stays bare so the quantifier and the extension list can both sit in
  // front of it: "a" + "PNG" + "file". Folding the article into the noun puts
  // the list in the wrong place ("Choose PNG a file").
  const noun =
    filter.select === "directory"
      ? many
        ? "folders"
        : "folder"
      : filter.select === "file"
        ? many
          ? "files"
          : "file"
        : many
          ? "files or folders"
          : "file or folder";
  const lead = many ? "one or more" : "a";
  if (!exts?.length || filter.select === "directory") {
    return `Choose ${lead} ${noun}`;
  }
  // Two is "A or B"; more is "A, B or C" — an Oxford-less list, because this is
  // a UI label and the comma-before-or reads as a fourth item at a glance.
  const list =
    exts.length === 1
      ? exts[0]
      : `${exts.slice(0, -1).join(", ")} or ${exts[exts.length - 1]}`;
  return `Choose ${lead} ${list} ${noun}`;
}
