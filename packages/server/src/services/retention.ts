/**
 * RetentionService — the periodic sweep that deletes what Dispatch keeps and
 * nothing else ever would.
 *
 * Three rules, each from a disk audit of a long-lived install with 30 GB left:
 *
 *   1. Checkpoints whose worktree is gone. 13,031 of 24,806 rows named a removed
 *      worktree, and their refs pinned commits `git gc` can never collect —
 *      9.6k refs in one repository. `WorktreeService.remove()` now retires them
 *      at removal; this catches the backlog and removals that bypass it.
 *   2. Reviewer chats, {@link REVIEWER_CHAT_RETENTION_MS} after their PR merged
 *      or closed. 374 of them; their findings already live on GitHub.
 *   3. Tool-output images older than {@link TOOL_IMAGE_RETENTION_MS}. ~420 MB of
 *      the 1.14 GB of chat images. Images the human attached are never touched,
 *      and neither is `messages.jsonl` — once Claude Code's own session cleanup
 *      runs, that transcript is the only copy of the conversation.
 *
 * Deliberately NOT here: metrics pruning (a manual button on purpose, see
 * services/metrics.ts), and `failed/` upgrade payloads, which belong to the
 * install root rather than this instance and are pruned by tools/app/upgrade.mjs.
 *
 * Windows are constants, not settings: none of these is a thing anyone should
 * have to tune, and a setting is a promise to support every value of it.
 */
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { TOOL_IMAGE_RETENTION_DAYS, parseReviewingTarget, type Chat } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { CheckpointService } from "./checkpoint.js";
import { formatBytes, mediaTypeFromName } from "./media-types.js";

const DAY_MS = 24 * 60 * 60_000;

/** How often the sweep runs. Its windows are measured in days. */
export const RETENTION_SWEEP_MS = 60 * 60_000;
/**
 * Delay before the first pass after boot. Long enough that the first pass is not
 * competing with session restore and the resume of chats a restart cut short;
 * short enough that a server restarted every day still gets swept.
 */
export const RETENTION_FIRST_SWEEP_MS = 5 * 60_000;
/** A reviewer chat outlives its PR's merge/close by this long. */
export const REVIEWER_CHAT_RETENTION_MS = 14 * DAY_MS;
/** A tool-output image outlives the turn that produced it by this long. */
export const TOOL_IMAGE_RETENTION_MS = TOOL_IMAGE_RETENTION_DAYS * DAY_MS;

/**
 * An asset name as the transcript spells it. Stored names are generated
 * (`<nanoid>.<ext>`), so this charset is exhaustive; `[\\/]+` also matches the
 * doubled backslash a path acquires inside a JSON string.
 */
const ASSET_REF = /assets[\\/]+([A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g;

export interface RetentionDeps {
  store: Store;
  checkpoints: Pick<CheckpointService, "sweepMissingWorktrees">;
  /** The full chat-deletion path (services/chat-deletion.ts), never `store.deleteChat`. */
  deleteChat: (chatId: string) => Promise<void>;
  /** True while a chat has a live turn — a busy chat is never deleted under itself. */
  isBusy: (chatId: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface RetentionReport {
  checkpoints: { rows: number; refs: number; skipped: number };
  reviewerChats: { deleted: string[] };
  images: { files: number; bytes: number; chats: number };
}

export class RetentionService {
  private readonly store: Store;
  private readonly checkpoints: RetentionDeps["checkpoints"];
  private readonly deleteChat: RetentionDeps["deleteChat"];
  private readonly isBusy: RetentionDeps["isBusy"];
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private timer?: ReturnType<typeof setInterval>;
  private firstTimer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Per chat: the transcript's size+mtime when its images were last judged, and
   * the earliest moment one of them becomes old enough to expire.
   *
   * Without it every hourly pass re-reads every transcript that holds an image
   * — including all the chats whose only images are the human's own, which
   * never expire and would be re-read forever. A chat is only read again when
   * its transcript has changed or a candidate has come due.
   */
  private readonly imageMemo = new Map<string, { size: number; mtimeMs: number; nextAt: number }>();

  constructor(deps: RetentionDeps) {
    this.store = deps.store;
    this.checkpoints = deps.checkpoints;
    this.deleteChat = deps.deleteChat;
    this.isBusy = deps.isBusy;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(`[Dispatch] retention: ${line}`));
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Arm the sweep. `unref`ed so neither timer can hold the process open. */
  start(intervalMs = RETENTION_SWEEP_MS, firstDelayMs = RETENTION_FIRST_SWEEP_MS): void {
    if (this.timer) return;
    const run = () => void this.sweep().catch((err: unknown) => this.log(`pass failed: ${String(err)}`));
    this.firstTimer = setTimeout(run, firstDelayMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = undefined;
    this.timer = undefined;
  }

  /** Await any in-flight pass (tests / graceful shutdown). */
  drain(): Promise<unknown> {
    return this.chain;
  }

  /** One pass of every rule. Serialized: a slow pass is never overlapped. */
  sweep(): Promise<RetentionReport> {
    const next = this.chain.then(() => this.runPass());
    this.chain = next.catch(() => {});
    return next;
  }

  private async runPass(): Promise<RetentionReport> {
    const chats = await this.store.listChats();
    const projects = await this.store.listProjects().catch(() => []);
    const repoByProject = new Map(projects.map((p) => [p.id, p.repoPath]));
    const repoByChat = new Map(chats.map((c) => [c.id, repoByProject.get(c.projectId)]));

    // Each rule isolated: a git failure in rule 1 must not cost rules 2 and 3
    // their pass, which is the same reasoning as `safeStart` in the container.
    const checkpoints = await this.checkpoints
      .sweepMissingWorktrees(async (chatId) => repoByChat.get(chatId) ?? null)
      .catch((err: unknown) => {
        this.log(`checkpoint sweep failed: ${String(err)}`);
        return { rows: 0, refs: 0, skipped: 0 };
      });
    if (checkpoints.rows) {
      this.log(
        `removed ${checkpoints.rows} checkpoint row(s) and ${checkpoints.refs} ref(s) ` +
          `for worktrees that no longer exist`,
      );
    }

    const deleted = await this.sweepReviewerChats(chats).catch((err: unknown) => {
      this.log(`reviewer-chat sweep failed: ${String(err)}`);
      return [] as string[];
    });
    if (deleted.length) {
      this.log(`deleted ${deleted.length} reviewer chat(s) whose PR settled: ${deleted.join(", ")}`);
    }

    const gone = new Set(deleted);
    const images = await this.sweepImages(chats.filter((c) => !gone.has(c.id))).catch(
      (err: unknown) => {
        this.log(`image sweep failed: ${String(err)}`);
        return { files: 0, bytes: 0, chats: 0 };
      },
    );
    if (images.files) {
      this.log(
        `expired ${images.files} tool-output image(s), ${formatBytes(images.bytes)}, ` +
          `across ${images.chats} chat(s)`,
      );
    }

    return { checkpoints, reviewerChats: { deleted }, images };
  }

  /* ------------------------------------------------------ reviewer chats */

  /**
   * Reviewer chats whose PR settled more than the window ago.
   *
   * The PR is found through `reviewOf`, or — for reviewer chats older than that
   * field — the target named in the `pr:review` purpose label. A reviewer that
   * cannot name its PR, or whose PR the catalog has never heard of, is kept:
   * nothing says its review is on GitHub.
   */
  private async sweepReviewerChats(chats: Chat[]): Promise<string[]> {
    const cutoff = this.now() - REVIEWER_CHAT_RETENTION_MS;
    const deleted: string[] = [];
    for (const chat of chats) {
      const key =
        chat.reviewOf ??
        (chat.purpose?.kind === "pr:review" ? parseReviewingTarget(chat.purpose.label) : null);
      if (!key) continue;
      const pr = await this.store.getPrRecord(key).catch(() => null);
      if (!pr || (pr.state !== "merged" && pr.state !== "closed")) continue;
      const settledAt = settledAtMs(pr);
      if (settledAt === null || settledAt > cutoff) continue;
      if (this.isBusy(chat.id)) continue;
      await this.deleteChat(chat.id);
      deleted.push(chat.id);
    }
    return deleted;
  }

  /* --------------------------------------------------------------- images */

  private async sweepImages(chats: Chat[]): Promise<{ files: number; bytes: number; chats: number }> {
    const now = this.now();
    const cutoff = now - TOOL_IMAGE_RETENTION_MS;
    let files = 0;
    let bytes = 0;
    let touched = 0;
    for (const chat of chats) {
      const images = (await this.store.listChatAssets(chat.id)).filter((a) =>
        mediaTypeFromName(a.name).startsWith("image/"),
      );
      if (!images.length) {
        this.imageMemo.delete(chat.id);
        continue;
      }
      const transcript = this.store.chatTranscriptPath(chat.id);
      if (!existsSync(transcript)) continue;
      const st = await stat(transcript);
      const memo = this.imageMemo.get(chat.id);
      if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs && now < memo.nextAt) {
        continue;
      }

      const { toolOutput, attached } = classifyAssets(await this.store.readMessageLines(chat.id));
      const sizes = new Map(images.map((a) => [a.name, a.size]));
      const expire: string[] = [];
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [name, lastTs] of toolOutput) {
        // An image the human attached is theirs, even if a tool also returned it.
        if (attached.has(name) || !sizes.has(name)) continue;
        if (lastTs <= cutoff) expire.push(name);
        else nextAt = Math.min(nextAt, lastTs + TOOL_IMAGE_RETENTION_MS);
      }
      const removed = await this.store.expireChatAssets(chat.id, expire, now);
      if (removed.length) {
        touched++;
        files += removed.length;
        for (const name of removed) bytes += sizes.get(name) ?? 0;
      }
      // A file that would not delete (held open on Windows) is due again now.
      if (removed.length < expire.length) nextAt = now;
      this.imageMemo.set(chat.id, { size: st.size, mtimeMs: st.mtimeMs, nextAt });
    }
    return { files, bytes, chats: touched };
  }
}

/**
 * Split a transcript's asset references by who produced them.
 *
 * `toolOutput` maps a name to the timestamp of the NEWEST tool result naming
 * it; `attached` holds every name a `user` row carries — a paste, a drop, or an
 * image another chat sent. Anything else that mentions an asset (assistant
 * prose, say) is neither, and a name that is neither is never expired: only an
 * image positively known to be tool output is.
 *
 * Works on raw lines and parses only the ones that contain `assets`, so a
 * transcript of mostly prose costs a substring scan.
 */
export function classifyAssets(lines: string[]): {
  toolOutput: Map<string, number>;
  attached: Set<string>;
} {
  const toolOutput = new Map<string, number>();
  const attached = new Set<string>();
  for (const line of lines) {
    if (!line.includes("assets")) continue;
    const names = [...line.matchAll(ASSET_REF)].map((m) => m[1]!);
    if (!names.length) continue;
    let row: { kind?: unknown; ts?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (row.kind === "user") {
      for (const n of names) attached.add(n);
    } else if (row.kind === "tool_result" && typeof row.ts === "number") {
      for (const n of names) toolOutput.set(n, Math.max(toolOutput.get(n) ?? 0, row.ts));
    }
  }
  return { toolOutput, attached };
}

/**
 * When a settled PR settled, epoch ms. GitHub's own `mergedAt`/`closedAt` when
 * the catalog has them; otherwise the last poll at which the row changed, which
 * for a PR that has stopped changing is the poll that saw it close.
 */
function settledAtMs(pr: { mergedAt?: string; closedAt?: string; lastChangedAt: number }): number | null {
  const iso = pr.mergedAt ?? pr.closedAt;
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(pr.lastChangedAt) && pr.lastChangedAt > 0 ? pr.lastChangedAt : null;
}
