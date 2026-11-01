/**
 * Cut every link out of a directory tree before anything deletes it.
 *
 * THE INCIDENT (2026-11-01). A dispatch-plugins worktree held `.dispatch-sdk`,
 * a gitignored junction to `claude-manager/packages/plugin-sdk`, plus pnpm
 * `link:` dependencies that resolved through it. Removing the worktree deleted
 * `packages/shared`, `packages/plugin-sdk` and 11 `node_modules/.pnpm`
 * packages out of the Dispatch checkout. `git worktree remove` did it: Git for
 * Windows 2.40 walks a junction as if it were a plain directory and deletes
 * what it points at (`worktree-links.test.ts` reproduces it). Node's `rm` did
 * not, but that is one runtime's implementation detail, not a contract worth
 * a checkout.
 *
 * So no recursive delete of a tree may run while a link is still inside it.
 * `severLinks` unlinks each one as a link, never entering it, and the delete
 * that follows meets only real files and directories.
 *
 * Why this is cheap enough. One `readdir` per real directory, with types from
 * the listing itself, so no `stat` per entry. Libuv reports every Windows
 * reparse point (junction, directory symlink, file symlink) as a link dirent,
 * so junctions are caught without a second look. A link costs a `readlink`,
 * so it can be put back, and an `unlink`. Measured on a pnpm-installed
 * worktree of this repo (5k directories, 1.9k links, Windows): the sever took
 * ~1s of a ~28s removal. And with no junctions left, git's own delete ran to
 * completion instead of dying part-way and leaving the rest to `rm`.
 */
import { lstat, readdir, readlink, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SeveredLink {
  path: string;
  /** `readlink`'s answer, verbatim (relative stays relative); null when unreadable. */
  target: string | null;
}

/**
 * Directories listed at once. Measured on a real worktree of this repo
 * (5k directories, Windows): 8 roughly halved a serial walk; 32 was slower
 * than 8, everything past libuv's four threads only queueing.
 */
const WALK_CONCURRENCY = 8;

/**
 * Unlink every symlink and junction under `root`, at any depth, without
 * following one. `root` itself being a link means the "tree" is only that
 * link, so it is unlinked and nothing behind it is walked.
 *
 * Fails closed: a link that cannot be removed, or a directory that cannot be
 * listed (it might hold a link we never saw), throws. Removal must stop there
 * rather than hand a delete a tree that still has a door out of it. Severed
 * links are pushed onto `into` as they go, so a caller that catches still
 * knows what to put back.
 */
export async function severLinks(root: string, into: SeveredLink[] = []): Promise<SeveredLink[]> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (err) {
    if (isGone(err)) return into;
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    into.push(await severOne(root));
    return into;
  }
  if (!rootStat.isDirectory()) return into;

  const pending = [root];
  let running = 0;
  let failure: unknown;
  await new Promise<void>((done) => {
    const pump = (): void => {
      while (failure === undefined && running < WALK_CONCURRENCY && pending.length > 0) {
        const dir = pending.pop()!;
        running++;
        visit(dir)
          .catch((err: unknown) => {
            failure ??= err;
          })
          .finally(() => {
            running--;
            pump();
          });
      }
      if (running === 0 && (pending.length === 0 || failure !== undefined)) done();
    };
    pump();
  });
  if (failure !== undefined) throw failure;
  return into;

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isGone(err)) return;
      throw err;
    }
    const links: string[] = [];
    for (const e of entries) {
      // Link first: on Windows a junction's dirent is a link and NOT a
      // directory, but the order makes that irrelevant on every platform.
      if (e.isSymbolicLink()) links.push(join(dir, e.name));
      else if (e.isDirectory()) pending.push(join(dir, e.name));
    }
    for (const link of links) into.push(await severOne(link));
  }
}

async function severOne(path: string): Promise<SeveredLink> {
  const target = await readlink(path).catch(() => null);
  try {
    await unlink(path);
  } catch (err) {
    if (isGone(err)) return { path, target };
    // A directory reparse point libuv cannot parse as a link refuses `unlink`.
    // `rmdir` takes the reparse point itself, never its target, and refuses a
    // real directory that still has contents, which is the failure we want.
    try {
      await rmdir(path);
    } catch {
      throw new Error(`could not unlink ${path} as a link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { path, target };
}

/**
 * Put back what `severLinks` cut, for a removal that was refused after all.
 * Returns the paths it could not restore. A directory link comes back as a
 * junction on Windows: creating one needs no privilege, and a symlink made by
 * someone who had that privilege may not be re-creatable by us.
 */
export async function restoreLinks(links: SeveredLink[]): Promise<string[]> {
  const failed: string[] = [];
  for (const { path, target } of links) {
    if (target === null) {
      failed.push(path);
      continue;
    }
    try {
      let type: "junction" | "file" | undefined;
      if (process.platform === "win32") {
        const isDir = await stat(resolve(dirname(path), target))
          .then((s) => s.isDirectory())
          .catch(() => false);
        type = isDir ? "junction" : "file";
      }
      await symlink(target, path, type);
    } catch {
      failed.push(path);
    }
  }
  return failed;
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
