/**
 * CheckpointService — per-turn, NON-DESTRUCTIVE git checkpoints of a worktree so
 * a chat message can roll back CODE + conversation.
 *
 * Mechanics (no branch switch, working tree preserved):
 *   snapshot()  After an assistant turn we snapshot the CURRENT worktree content
 *               into a git tree and commit object, then point a hidden ref
 *               `refs/cm/checkpoints/<chatId>/<n>` at it. We never touch HEAD, the
 *               branch, the real index, or the working files. Capture is done via a
 *               throwaway temp index (GIT_INDEX_FILE) so `git add -A` + `write-tree`
 *               see the live worktree without disturbing the user's staging area.
 *               The messageId→ref mapping is persisted in checkpoints.json (Store)
 *               and a `checkpoint` domain event is published on the bus.
 *
 *   rollback()  Restore the worktree files to a checkpoint ref's tree, EXACTLY:
 *               tracked/modified files are overwritten with the snapshot content,
 *               files deleted since the snapshot are recreated, and files added
 *               since the snapshot are removed. Done through a temp index +
 *               `checkout-index`, so HEAD/branch/other refs are untouched — newer
 *               checkpoints survive. Returns the SDK session fork target (message
 *               uuid) so the SessionBroker can fork the conversation to match.
 *
 * All git work respects `.gitignore` (via `git add -A` / `--exclude-standard`), so
 * ignored trees like node_modules are never snapshotted or deleted.
 */
import { execa } from "execa";
import { rm, rmdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Checkpoint } from "@cm/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import { KeyedMutex } from "../store/fsq.js";

/** Hidden ref namespace holding per-chat checkpoint commits. */
export const CHECKPOINT_REF_NS = "refs/cm/checkpoints";

/** Dependencies injected into the service (store + bus; `gitBin` for tests). */
export interface CheckpointServiceDeps {
  store: Store;
  bus: EventBus;
  /** git executable (default "git"). */
  gitBin?: string;
}

/** Everything needed to snapshot the worktree for one turn. */
export interface SnapshotInput {
  chatId: string;
  /** The transcript message id this checkpoint restores TO. */
  messageId: string;
  /** Absolute path to the worktree to snapshot. */
  worktreePath: string;
  /** SDK message uuid to fork/resume the session at on rollback. */
  sessionMessageUuid?: string;
}

/** Result of a rollback: the checkpoint restored + the conversation fork target. */
export interface RollbackResult {
  checkpoint: Checkpoint;
  ref: string;
  worktreePath: string;
  /** SDK message uuid the SessionBroker should fork the conversation at. */
  sessionMessageUuid?: string;
  /** Files that existed after the checkpoint and were removed to match it. */
  removed: string[];
}

/** Fixed identity so `commit-tree` never fails on a repo with no user config. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "claude-manager",
  GIT_AUTHOR_EMAIL: "cm@localhost",
  GIT_COMMITTER_NAME: "claude-manager",
  GIT_COMMITTER_EMAIL: "cm@localhost",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
} as const;

/** Config flags forced on every call for byte-exact, deterministic snapshots. */
const GIT_CONFIG_ARGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
];

/**
 * git ref names allow a limited charset; map anything else to '-'. We deliberately
 * do NOT trim leading/trailing '-': nanoid ids can begin or end with '-', and
 * trimming would alias distinct chatIds (e.g. "-abc" and "abc") onto one ref
 * namespace — cross-contaminating `nextIndex` and `listCheckpointRefs`. A leading
 * '-' is safe here since it only ever appears mid-refname (after "refs/cm/…/").
 */
function sanitizeRefSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "-");
  return cleaned.length > 0 ? cleaned : "chat";
}

export class CheckpointService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly gitBin: string;
  /** Serialize snapshot/rollback per chat so ref numbering never races. */
  private readonly locks = new KeyedMutex();

  constructor(deps: CheckpointServiceDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.gitBin = deps.gitBin ?? "git";
  }

  /* --------------------------------------------------------------- git glue */

  private async git(
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const res = await execa(this.gitBin, [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      env: extraEnv ? { ...GIT_ENV, ...extraEnv } : { ...GIT_ENV },
      stripFinalNewline: true,
    });
    return res.stdout;
  }

  /** Run git allowing a non-zero exit (returns stdout, empty on failure). */
  private async gitTry(args: string[], cwd: string): Promise<string> {
    const res = await execa(this.gitBin, [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      env: { ...GIT_ENV },
      stripFinalNewline: true,
      reject: false,
    });
    return res.exitCode === 0 ? res.stdout : "";
  }

  /** Allocate a fresh, absolute temp index path (git creates the file). */
  private tempIndexPath(): string {
    return join(tmpdir(), `cm-idx-${randomBytes(8).toString("hex")}`);
  }

  private refPrefix(chatId: string): string {
    return `${CHECKPOINT_REF_NS}/${sanitizeRefSegment(chatId)}`;
  }

  /** Next monotonic `<n>` for this chat's checkpoint refs (max existing + 1). */
  private async nextIndex(chatId: string, cwd: string): Promise<number> {
    const prefix = this.refPrefix(chatId);
    const out = await this.gitTry(
      ["for-each-ref", "--format=%(refname)", prefix],
      cwd,
    );
    let max = 0;
    for (const line of out.split("\n")) {
      const l = line.trim();
      if (!l.startsWith(`${prefix}/`)) continue;
      const seg = l.slice(prefix.length + 1);
      if (seg.includes("/")) continue;
      const n = Number.parseInt(seg, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  /* ---------------------------------------------------------------- snapshot */

  /**
   * Snapshot the current worktree content into a hidden checkpoint ref and record
   * the messageId→ref mapping. Non-destructive: HEAD, the branch, the real index,
   * and the working files are all left exactly as they were.
   */
  async snapshot(input: SnapshotInput): Promise<Checkpoint> {
    const { chatId, messageId, worktreePath, sessionMessageUuid } = input;
    return this.locks.run(`cp:${chatId}`, async () => {
      const tmpIndex = this.tempIndexPath();
      let commit: string;
      let ref: string;
      try {
        const env = { GIT_INDEX_FILE: tmpIndex };
        // Stage the entire live worktree into a throwaway index, then hash it.
        await this.git(["add", "-A"], worktreePath, env);
        const tree = await this.git(["write-tree"], worktreePath, env);
        // Parent on HEAD when the repo has a commit (keeps context; refs pin it
        // alive regardless). A commit-less repo just gets a parentless snapshot.
        const head = await this.gitTry(
          ["rev-parse", "--verify", "--quiet", "HEAD"],
          worktreePath,
        );
        const commitArgs = ["commit-tree", tree];
        if (head) commitArgs.push("-p", head);
        commitArgs.push("-m", `cm checkpoint ${chatId} ${messageId}`);
        commit = await this.git(commitArgs, worktreePath);
        const n = await this.nextIndex(chatId, worktreePath);
        ref = `${this.refPrefix(chatId)}/${n}`;
        await this.git(["update-ref", ref, commit], worktreePath);
      } finally {
        await rm(tmpIndex, { force: true }).catch(() => {});
      }

      const cp: Checkpoint = {
        messageId,
        chatId,
        ref,
        sessionMessageUuid,
        worktreePath,
        createdAt: Date.now(),
      };
      const saved = await this.store.saveCheckpoint(cp);
      this.bus.publish({ type: "checkpoint", chatId, messageId, ref });
      return saved;
    });
  }

  /* ---------------------------------------------------------------- rollback */

  /**
   * Restore the worktree to the checkpoint recorded for `messageId`, and return
   * the conversation fork target. Newer checkpoint refs are preserved (we only
   * ever read the target ref and rewrite working files — never touch HEAD/refs).
   */
  async rollback(chatId: string, messageId: string): Promise<RollbackResult> {
    const cp = await this.store.getCheckpoint(chatId, messageId);
    if (!cp) {
      throw new Error(
        `No checkpoint for chat ${chatId} at message ${messageId}`,
      );
    }
    const worktreePath = cp.worktreePath;
    if (!worktreePath) {
      throw new Error(`Checkpoint ${cp.ref} has no worktreePath to restore`);
    }
    return this.locks.run(`cp:${chatId}`, async () => {
      const removed = await this.restoreTree(cp.ref, worktreePath);
      return {
        checkpoint: cp,
        ref: cp.ref,
        worktreePath,
        sessionMessageUuid: cp.sessionMessageUuid,
        removed,
      };
    });
  }

  /**
   * Make the worktree match `ref`'s tree exactly. Returns the paths that were
   * present after the checkpoint and had to be deleted to match it.
   */
  private async restoreTree(ref: string, cwd: string): Promise<string[]> {
    const target = await this.lsTree(ref, cwd);
    const current = await this.lsCurrentFiles(cwd);

    const tmpIndex = this.tempIndexPath();
    try {
      const env = { GIT_INDEX_FILE: tmpIndex };
      // Load the snapshot tree into a temp index and write every file back out,
      // overwriting modifications and recreating anything deleted since.
      await this.git(["read-tree", `${ref}^{tree}`], cwd, env);
      await this.git(["checkout-index", "-a", "-f"], cwd, env);
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => {});
    }

    // Remove files that exist now but weren't in the snapshot (post-checkpoint
    // additions). Ignored files never appear in `current`, so they're left alone.
    const removed: string[] = [];
    for (const rel of current) {
      if (target.has(rel)) continue;
      try {
        await rm(join(cwd, rel), { force: true });
        removed.push(rel); // only report a file we actually deleted
      } catch {
        /* e.g. a Windows lock held by a runner — leave it, don't claim removal */
      }
    }
    // Removing a file can leave its (now-empty) parent dirs behind; git ignores
    // empty dirs but they show in the file tree / Monaco. Prune them bottom-up.
    await this.pruneEmptyDirs(cwd, removed);
    return removed;
  }

  /**
   * Best-effort removal of directories left empty by deletions. `rmdir` (non-
   * recursive) fails on a non-empty dir — exactly the guard we want, so a dir
   * still holding snapshot files is kept. Deepest-first so children go before parents.
   */
  private async pruneEmptyDirs(cwd: string, removed: string[]): Promise<void> {
    const dirs = new Set<string>();
    for (const rel of removed) {
      let d = dirname(rel);
      while (d && d !== "." && d !== "/" && !d.startsWith("..")) {
        dirs.add(d);
        const parent = dirname(d);
        if (parent === d) break;
        d = parent;
      }
    }
    const ordered = [...dirs].sort(
      (a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length,
    );
    for (const rel of ordered) {
      await rmdir(join(cwd, rel)).catch(() => {});
    }
  }

  /** Paths (repo-relative, '/'-separated) contained in a ref's tree. */
  private async lsTree(ref: string, cwd: string): Promise<Set<string>> {
    const out = await this.git(
      ["ls-tree", "-r", "-z", "--name-only", ref],
      cwd,
    );
    return new Set(out.split("\0").filter((p) => p.length > 0));
  }

  /** Tracked + untracked (non-ignored) files currently present in the worktree. */
  private async lsCurrentFiles(cwd: string): Promise<string[]> {
    const out = await this.git(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
    );
    return [...new Set(out.split("\0").filter((p) => p.length > 0))];
  }

  /* ------------------------------------------------------------- accessors */

  /** Full checkpoint-ref names for a chat, ascending by index (for UI/tests). */
  async listCheckpointRefs(chatId: string, cwd: string): Promise<string[]> {
    const prefix = this.refPrefix(chatId);
    const out = await this.gitTry(
      ["for-each-ref", "--format=%(refname)", prefix],
      cwd,
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${prefix}/`))
      .sort((a, b) => {
        const na = Number.parseInt(a.slice(prefix.length + 1), 10) || 0;
        const nb = Number.parseInt(b.slice(prefix.length + 1), 10) || 0;
        return na - nb;
      });
  }
}
