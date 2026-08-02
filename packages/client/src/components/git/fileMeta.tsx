/**
 * Presentation for a changed path: the one-letter badge, its colour, and the
 * label. Kept in one place so the changes list, the history detail and the
 * stash detail all speak the same visual language.
 */
import type { GitChangeStatus } from "@cm/shared";
import type { Tone } from "../ui/Chip.js";

export interface StatusMeta {
  /** Single-letter badge, matching git's own porcelain letters. */
  letter: string;
  label: string;
  tone: Tone;
  /** Tailwind text colour for the letter badge. */
  className: string;
}

const META: Record<GitChangeStatus, StatusMeta> = {
  modified: { letter: "M", label: "Modified", tone: "warn", className: "text-warn" },
  added: { letter: "A", label: "Added", tone: "success", className: "text-success" },
  deleted: { letter: "D", label: "Deleted", tone: "danger", className: "text-danger" },
  renamed: { letter: "R", label: "Renamed", tone: "accent", className: "text-accent-hi" },
  copied: { letter: "C", label: "Copied", tone: "accent", className: "text-accent-hi" },
  "type-changed": { letter: "T", label: "Type changed", tone: "warn", className: "text-warn" },
  untracked: { letter: "U", label: "Untracked", tone: "muted", className: "text-muted" },
  conflicted: { letter: "!", label: "Conflicted", tone: "danger", className: "text-danger" },
  unknown: { letter: "?", label: "Changed", tone: "muted", className: "text-muted" },
};

export function statusMeta(status: GitChangeStatus): StatusMeta {
  return META[status] ?? META.unknown;
}

/** `src/components/Foo.tsx` → `{ name: "Foo.tsx", dir: "src/components" }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}

/** "2m ago" / "3d ago" — the same shape the memory list uses. */
export function relTime(ms?: number): string {
  if (typeof ms !== "number" || !ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}
