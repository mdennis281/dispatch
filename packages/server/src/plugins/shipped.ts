/**
 * Where the BUILT-IN plugins live: `packages/plugins/`, a sibling of this
 * server package in both the checkout and the release payload.
 *
 * Found by walking up to the server package's own `package.json` rather than by
 * a fixed `../..`, because this module sits at `src/plugins/` under tsx in dev
 * and at `dist/plugins/` in production — the same reason `bundled-skills.ts`
 * walks up to find `skills/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findShippedPluginsRoot(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "@dispatch/server") {
          const root = resolve(dir, "..", "plugins");
          return existsSync(root) ? root : undefined;
        }
      } catch {
        /* an unreadable package.json is not ours; keep walking */
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
