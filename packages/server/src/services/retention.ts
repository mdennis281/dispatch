/**
 * RetentionService — the periodic sweep that deletes what Dispatch keeps and
 * nothing else ever would.
 *
 * Four rules. The first three come from a disk audit of a long-lived install
 * with 30 GB left; the fourth is off by default and exists only because someone
 * asked for it:
 *
 *   1. Checkpoints whose worktree is gone. 13,031 of 24,806 rows named a removed
 *      worktree, and their refs pinned commits `git gc` can never collect —
 *      9.6k refs in one repository. `WorktreeService.remove()` now retires them
 *      at removal; this catches the backlog and removals that bypass it.
 *   2. Reviewer chats, the reviewer window after their PR merged or closed. 374 of them; their findings already live on GitHub.
 *   3. Tool-output images older than the image window. ~420 MB of the 1.14 GB of
 *      chat images. Images the human attached are never touched, and neither is
 *      `messages.jsonl` — once Claude Code's own session cleanup runs, that
 *      transcript is the only copy of the conversation.
 *   4. Chats idle longer than the chat-delete window — OFF unless configured.
 *      The only rule here that deletes a CONVERSATION rather than something
 *      derived from one, which is why it defaults to off and why it refuses a
 *      long list of chats that are merely old (see {@link sweepAgedChats}).
 *
 * Deliberately NOT here: metrics pruning (a manual button on purpose, see
 * services/metrics.ts), and `failed/` upgrade payloads, which belong to the
 * install root rather than this instance and are pruned by tools/app/upgrade.mjs.
 *
 * Windows are SETTINGS (`AppSettings.retention`, resolved by
 * `@dispatch/shared/retention.ts`), and the constants here are now their
 * defaults. This file used to argue the opposite — "none of these is a thing
 * anyone should have to tune, and a setting is a promise to support every value
 * of it" — and half of that was right: the promise is real, which is why every
 * field is bounded and why rule 4 has a floor it validates rather than clamps.
 * The other half did not survive an install big enough to need them. How much
 * disk a year of work costs turned out to be exactly the thing someone wants to
 * move, and moving it meant editing this file.
 *
 * The sweep CADENCE below is still a constant: it is an implementation detail of
 * enforcing the windows, not a window.
 */
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  DEFAULT_REVIEWER_CHAT_DAYS,
  DEFAULT_TOOL_IMAGE_DAYS,
  isGlobalProject,
  parseReviewingTarget,
  resolveRetention,
  type Chat,
  type ResolvedRetention,
} from "@dispatch/shared";
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
/**
 * Default windows in ms, for a caller with no settings to hand (tests, and the
 * `?? ` on the resolve below). The DAY numbers are the shared defaults — these
 * are derived from them rather than re-stated, so there is one place to change.
 */
export const REVIEWER_CHAT_RETENTION_MS = DEFAULT_REVIEWER_CHAT_DAYS * DAY_MS;
export const TOOL_IMAGE_RETENTION_MS = DEFAULT_TOOL_IMAGE_DAYS * DAY_MS;
/**
 * Most chats one pass of rule 4 will delete. See {@link RetentionService.sweepAgedChats}
 * for why a backlog drains over passes rather than in one tick.
 */
export const AGED_CHAT_DELETE_LIMIT = 25;

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
  /** Rule 4. Always present; `deleted` is empty when the window is off. */
  agedChats: { deleted: string[]; skipped: number };
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
    // Resolved ONCE per pass, not per rule: a settings write landing between two
    // rules would otherwise have one pass enforcing two different policies, and
    // the log line would name neither.
    const settings = await this.store.getSettings().catch(() => null);
    const policy = resolveRetention(settings?.retention);
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

    const deleted = await this.sweepReviewerChats(chats, policy.reviewerChatMs).catch((err: unknown) => {
      this.log(`reviewer-chat sweep failed: ${String(err)}`);
      return [] as string[];
    });
    if (deleted.length) {
      this.log(`deleted ${deleted.length} reviewer chat(s) whose PR settled: ${deleted.join(", ")}`);
    }

    const gone = new Set(deleted);
    const aged = await this.sweepAgedChats(
      chats.filter((c) => !gone.has(c.id)),
      policy.chatDeleteMs,
    ).catch((err: unknown) => {
      this.log(`aged-chat sweep failed: ${String(err)}`);
      return { deleted: [] as string[], skipped: 0 };
    });
    if (aged.deleted.length) {
      this.log(
        `deleted ${aged.deleted.length} chat(s) idle longer than ` +
          `${policy.chatDeleteDays.effective}d (${aged.skipped} kept as still in use)`,
      );
    }

    for (const id of aged.deleted) gone.add(id);
    const images = await this.sweepImages(
      chats.filter((c) => !gone.has(c.id)),
      policy.toolImageMs,
    ).catch(
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

    return { checkpoints, reviewerChats: { deleted }, images, agedChats: aged };
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
  private async sweepReviewerChats(chats: Chat[], windowMs: number): Promise<string[]> {
    const cutoff = this.now() - windowMs;
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

  /* ------------------------------------------------------------ aged chats */

  /**
   * Chats whose last activity is older than the window. **Off when `windowMs` is
   * 0, which is the default.**
   *
   * This is the only rule that deletes a conversation rather than something
   * derived from one, and `messages.jsonl` is the only copy of it once Claude
   * Code's own session cleanup has run. So "old" is necessary but nowhere near
   * sufficient, and every refusal below is a way a chat can be months idle and
   * still live work:
   *
   *  - **Busy.** Same guard rule 2 uses: never delete a chat under itself.
   *  - **The global chat.** A singleton surface, not a conversation in a series.
   *    Idle for a year it is still the thing the next global message lands in.
   *  - **An unsettled PR.** `PRRef.state` absent counts as unsettled: a chat
   *    whose PR we cannot classify is a chat whose work we cannot classify. A
   *    long-running PR that nobody has touched in three months is exactly the
   *    thing someone comes back to.
   *  - **A live worktree.** `Chat.worktrees` is rewritten to the LIVE set by the
   *    detector on every reconcile, so a non-empty list means a checkout exists
   *    on disk right now — with, as often as not, uncommitted work in it.
   *
   * No pass deletes more than {@link AGED_CHAT_DELETE_LIMIT}. A window set for
   * the first time on this install has 521 chats past 30 days, and deleting 521
   * conversations inside one hourly tick — each a full `deleteChat` that stops a
   * session, clears attention and unlinks worktrees — is both a long stall and a
   * mistake that is maximally expensive if the window was a typo. Spread over
   * passes, the backlog still drains within a day and the first log line arrives
   * while there is still something left to keep.
   */
  private async sweepAgedChats(
    chats: Chat[],
    windowMs: number,
  ): Promise<{ deleted: string[]; skipped: number }> {
    if (windowMs <= 0) return { deleted: [], skipped: 0 };
    const cutoff = this.now() - windowMs;
    const deleted: string[] = [];
    let skipped = 0;
    // Oldest first, so a capped pass takes the chats furthest past the window
    // rather than whatever order the directory listing happened to produce.
    const candidates = chats
      .filter((c) => (c.updatedAt ?? c.createdAt ?? 0) <= cutoff)
      .sort((a, b) => (a.updatedAt ?? a.createdAt ?? 0) - (b.updatedAt ?? b.createdAt ?? 0));
    for (const chat of candidates) {
      if (deleted.length >= AGED_CHAT_DELETE_LIMIT) break;
      if (!this.mayDeleteAged(chat)) {
        skipped++;
        continue;
      }
      await this.deleteChat(chat.id);
      deleted.push(chat.id);
    }
    return { deleted, skipped };
  }

  /** The refusals above, in the order that is cheapest to check. */
  private mayDeleteAged(chat: Chat): boolean {
    if (this.isBusy(chat.id)) return false;
    if (isGlobalProject(chat.projectId)) return false;
    if (chat.worktrees.length) return false;
    if (chat.prs.some((pr) => pr.state !== "merged" && pr.state !== "closed")) return false;
    return true;
  }

  /* --------------------------------------------------------------- images */

  private async sweepImages(
    chats: Chat[],
    windowMs: number,
  ): Promise<{ files: number; bytes: number; chats: number }> {
    const now = this.now();
    const cutoff = now - windowMs;
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
        else nextAt = Math.min(nextAt, lastTs + windowMs);
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
