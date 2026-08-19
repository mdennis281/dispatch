/**
 * Every renderer that receives a tool result must be able to SHOW its images.
 *
 * The bug this exists to prevent, in full: the ingest side was completely
 * correct. An agent `Read` a PNG, the server sniffed it, persisted it to the
 * chat's assets and attached a well-formed `ImageRef` with real dimensions —
 * and the transcript showed a filename and a line count, because `Read` is a
 * file tool and `FileRunGroup` never looked at `result.images`. Five of the
 * seven renderers didn't. Only `ToolCallCard` and `UserRow` ever did.
 *
 * So the failure was not "images don't work". It was "images work everywhere
 * except the single most common way an agent looks at one", which is far harder
 * to notice — and impossible to catch with a test of the parsing layer, because
 * every one of those passed.
 *
 * This is a static check rather than a render test because the client's vitest
 * runs in a `node` environment with no DOM (see `vitest.config.ts`). Same shape
 * as `ui/rawButtons.test.ts`: cheap, no new toolchain, and it fails on the
 * NEXT renderer that forgets rather than on a bug report months later.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `packages/client/src`. */
const SRC = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Anything that renders media, directly or through the shared strip.
 *
 * Matches JSX USE (`<ResultMediaStrip`), not a bare mention. Every file in
 * `RENDERERS` names the strip in a comment explaining why it is there, so a
 * plain substring match would keep passing after someone deleted the element
 * and left the prose behind — the precise regression this file exists to
 * catch, waved through by the thing meant to catch it.
 */
const RENDERS_MEDIA = /<\s*(ResultMediaStrip|MediaGroup|Attachment|ImageThumb|AssetMedia)[\s/>]/;

/**
 * Blank out comments and string literals before matching, so neither a doc
 * comment nor a quoted example can satisfy the check.
 *
 * Crude — it does not parse JSX, regex literals or template interpolation. It
 * only has to be sound in the ONE direction that matters: it can never turn a
 * real `<ResultMediaStrip …>` into a miss, because a mounted element is not
 * inside a comment or a quoted string. Being over-eager elsewhere costs
 * nothing, since the result is only ever fed to `RENDERS_MEDIA`.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** Does this source actually MOUNT a media component, rather than mention one? */
function mountsMedia(source: string): boolean {
  return RENDERS_MEDIA.test(stripCommentsAndStrings(source));
}

/**
 * Files that take a `ToolResultRow` but legitimately never draw one.
 *
 * Each needs a reason. "It doesn't have a chatId handy" is not one — every
 * renderer in the transcript can reach the chat id.
 */
const EXEMPT: Record<string, string> = {
  "components/chat/MessageList.tsx":
    "Dispatches to the group renderers; each of those mounts the strip itself.",
  "components/chat/rows/ResultMediaStrip.tsx": "IS the strip.",
  "components/chat/rows/DispatchToolCard.tsx":
    "Manager MCP tools (recall, wait, pr…) return text and structured state, never media. " +
    "If one ever does, delete this line rather than adding a special case.",
};

/** Renderers that receive tool results, relative to `src`. */
const RENDERERS = [
  "components/chat/MessageList.tsx",
  "components/chat/rows/DispatchToolCard.tsx",
  "components/chat/rows/FileRunGroup.tsx",
  "components/chat/rows/PrRunGroup.tsx",
  "components/chat/rows/ResultMediaStrip.tsx",
  "components/chat/rows/ShellRunGroup.tsx",
  "components/chat/rows/ToolCallCard.tsx",
  "components/agents/RunStream.tsx",
];

describe("media coverage", () => {
  it("every tool-result renderer can show images", () => {
    const missing = RENDERERS.filter((rel) => {
      if (rel in EXEMPT) return false;
      return !mountsMedia(readFileSync(join(SRC, rel), "utf8"));
    });

    expect(
      missing,
      `These render tool results but would silently drop result.images:\n  ${missing.join(
        "\n  ",
      )}\nMount <ResultMediaStrip chatId={…} results={…} />, or add an EXEMPT entry saying why the tool can never return media.`,
    ).toEqual([]);
  });

  it("cannot be satisfied by a mention — only by mounting the thing", () => {
    // The guard, guarding itself. Without this the check above would go green
    // for a file that merely TALKS about the strip, which is the state every
    // one of these files is one deletion away from.
    const notMounted = [
      "// renders ResultMediaStrip below\nreturn <div />;",
      "/** See MediaGroup for why. */ return <div />;",
      'const doc = "<ResultMediaStrip />"; return <div />;',
      "import { ResultMediaStrip } from './x.js';",
    ];
    for (const source of notMounted) {
      expect(mountsMedia(source), source).toBe(false);
    }

    // …and is still satisfied by the real thing, in the spellings that occur.
    const mounted = [
      "return <ResultMediaStrip chatId={id} results={r} />;",
      "return <MediaGroup\n  chatId={id}\n  assets={a}\n/>;",
      "return <Attachment {...p} />;",
    ];
    for (const source of mounted) {
      expect(mountsMedia(source), source).toBe(true);
    }
  });

  it("the renderer list still matches what actually takes a ToolResultRow", () => {
    // Guards the guard: a NEW renderer must be added to RENDERERS, or the check
    // above silently stops covering the thing that regressed in the first place.
    for (const rel of RENDERERS) {
      expect(readFileSync(join(SRC, rel), "utf8"), rel).toMatch(/ToolResultRow|RunStep/);
    }
  });
});
