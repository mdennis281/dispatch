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

/** Anything that renders media, directly or through the shared strip. */
const RENDERS_MEDIA = /ResultMediaStrip|MediaGroup|Attachment|ImageThumb|AssetMedia/;

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
      return !RENDERS_MEDIA.test(readFileSync(join(SRC, rel), "utf8"));
    });

    expect(
      missing,
      `These render tool results but would silently drop result.images:\n  ${missing.join(
        "\n  ",
      )}\nMount <ResultMediaStrip chatId={…} results={…} />, or add an EXEMPT entry saying why the tool can never return media.`,
    ).toEqual([]);
  });

  it("the renderer list still matches what actually takes a ToolResultRow", () => {
    // Guards the guard: a NEW renderer must be added to RENDERERS, or the check
    // above silently stops covering the thing that regressed in the first place.
    for (const rel of RENDERERS) {
      expect(readFileSync(join(SRC, rel), "utf8"), rel).toMatch(/ToolResultRow|RunStep/);
    }
  });
});
