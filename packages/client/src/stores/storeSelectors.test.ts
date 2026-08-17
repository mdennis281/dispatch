/**
 * The unstable-snapshot rule, as a test.
 *
 * zustand v5 dropped the equality argument, so `useStore`'s `getSnapshot` is
 * literally `selector(getState())` — it is re-run every time React checks the
 * store, and whatever it returns is compared by reference. A selector that
 * BUILDS its answer (`Object.values`, `.map`, `.filter`, `.sort`, a spread, an
 * object literal) therefore hands back a different reference every single call,
 * React concludes the store changed during commit, re-renders synchronously,
 * checks again — and never converges.
 *
 * What that looks like in production is not a slow list. It is the whole app
 * white with `Minified React error #185` (Maximum update depth exceeded) and a
 * stack of nothing but React internals, from a component that only READS. It
 * shipped exactly once, as `usePrs(selectPrs)` in `WorkspaceView` — which is
 * mounted at the app root and runs its hooks whether or not the overlay is open,
 * so a PR list nobody had opened took down the entire UI.
 *
 * The fix is always the same and it is one word: wrap the selector in
 * `useShallow`, behind a `useX()` hook in the store module, the way every other
 * derived list in this directory already is.
 *
 * This checks the ONE shape that is unambiguous from source alone: a named
 * `select*` handed straight to a store hook. Inline arrow selectors are
 * deliberately not matched — most of them narrow to a primitive
 * (`(s) => Object.values(s.byId).filter(...).length` is perfectly safe), and a
 * rule that starts red is a rule everyone learns to skip.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `packages/client/src`. */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * `useAnything(selectAnything)` — a named selector passed bare to a store hook.
 * Whitespace-tolerant so a prettier reflow across lines can't slip one through.
 *
 * `useShallow` is excluded because it is the FIX: `useShallow(selectPrs)` is a
 * `use…(select…)` call by shape and the one spelling this rule exists to allow.
 */
const BARE_SELECTOR = /\buse(?!Shallow\b)[A-Z]\w*\(\s*select[A-Z]\w*\s*[),]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("store selectors", () => {
  it("never hands a named selector straight to a store hook", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const hit of readFileSync(file, "utf8").matchAll(BARE_SELECTOR)) {
        offenders.push(`${relative(SRC, file).replace(/\\/g, "/")}: ${hit[0].slice(0, -1)})`);
      }
    }
    expect(
      offenders,
      `A selector that builds a new array or object is a new reference on every ` +
        `getSnapshot call, which makes React re-render until it throws ` +
        `"Maximum update depth exceeded" — with the whole app white. Wrap it: ` +
        `useShallow(selectX), behind a useX() hook in the store module.\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
