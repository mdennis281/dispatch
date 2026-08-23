/**
 * Copy hand-written `.mjs` next to its compiled neighbours.
 *
 * `tsc` only emits what it compiles, so a `.mjs` checked into `src/` never
 * reaches `dist/` — and the files here are exactly the ones that must NOT be
 * compiled, because they are spawned BY PATH from a module that resolves them
 * relative to itself. Compiling them would put them at `dist/…` in a build and
 * leave `tsx watch` looking for them under `src/…` in dev; keeping them as
 * source and copying them means one relative path is correct in both.
 *
 * See `services/mcp/lazy-browser-shim.mjs` for the one that motivated this.
 *
 * `readdir({ recursive })` rather than `fs/promises.glob`, which is newer than
 * the Node floor this has to build on.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

const entries = await readdir(src, { recursive: true, withFileTypes: true });
let copied = 0;
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
  // Test fixtures are spawned from `src` by the tests that own them and have no
  // business in a shipped payload.
  if (entry.parentPath.split(/[\\/]/).includes("fixtures")) continue;
  // `parentPath` is where the walk found it; relative to `src` it is the same
  // path the module's own `import.meta.url` will resolve against inside `dist`.
  const rel = join(relative(src, entry.parentPath), entry.name);
  const target = join(dist, rel);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(src, rel), target);
  copied += 1;
  console.log(`copied ${relative(root, target)}`);
}
if (copied === 0) console.log("no .mjs assets to copy");
