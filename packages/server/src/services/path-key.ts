/**
 * Path identity for the server: are two strings the same place on disk?
 *
 * There used to be four answers to that. worktree.ts and instance.ts folded case
 * only on Windows; agent-cwd.ts folded it EVERYWHERE, so on Linux it treated
 * `/repo/App` and `/repo/app` (two real, distinct directories) as one and could
 * wave a write into the wrong tree through its displacement check; and
 * subscriptions.ts had a fourth copy. One rule now: resolve, drop trailing
 * separators, and fold case only where the filesystem does (NTFS).
 */
import { posix, win32 } from "node:path";

/**
 * {@link pathKey} for an explicit platform, so both rules are testable on either
 * CI leg. Deliberately NOT an optional second parameter on `pathKey` itself:
 * `paths.map(pathKey)` is idiomatic here, and it would hand the array INDEX in as
 * the platform — every key after the first silently case-sensitive.
 */
export function pathKeyOn(platform: NodeJS.Platform, p: string): string {
  const isWin = platform === "win32";
  let out = (isWin ? win32 : posix).resolve(p);
  // A loop, not `/[\\/]+$/`: that pattern backtracks quadratically on a long run
  // of separators, and CodeQL (js/polynomial-redos) flags it once a path can come
  // from a stored row. Stop at length 1 so POSIX `/` survives; a Windows drive
  // root resolves to `C:\`, which becomes `C:` on BOTH sides of any comparison.
  while (out.length > 1 && (out.endsWith("/") || (isWin && out.endsWith("\\")))) out = out.slice(0, -1);
  return isWin ? out.toLowerCase() : out;
}

/** Comparison key for a path — resolved, no trailing separator, case-folded on Windows. */
export function pathKey(p: string): string {
  return pathKeyOn(process.platform, p);
}

/** Two filesystem paths point at the same location (case-insensitive on Windows only). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
