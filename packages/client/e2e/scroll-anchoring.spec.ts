/**
 * Does `probeScrollAnchoring` actually measure what it claims, in real engines?
 *
 * This is the one piece of logic the row-virtualization fix rests on, and it is
 * the same CLASS of thing that broke silently for months: `@supports not
 * (overflow-anchor: auto)` looked like a behaviour check, tested only parsing,
 * and shipped wrong on every iPhone for months because nothing ever ran it
 * against a real engine. A regex over the stylesheet (`src/rowVirtualization.
 * test.ts`) can prove the WIRING is in place; only a browser can prove the
 * probe's answer.
 *
 * So this launches Chromium and WebKit and hands them the REAL function —
 * imported, not copied, and serialized into the page by `page.evaluate`, which
 * works because the probe closes over nothing (see its docblock). A future edit
 * to its geometry or threshold that flips the answer fails here.
 *
 * TWO assertions per engine, because "returns true" alone is worthless: a probe
 * hard-wired to `return true` would pass it. The negative control suppresses
 * anchoring with `overflow-anchor: none` and requires the probe to notice —
 * that is what makes the positive result mean something.
 *
 * Own lifecycle, like `shell-live.spec.ts`: the shared `playwright.config.ts`
 * has a single Desktop Chrome project, and cross-engine coverage is this spec's
 * business rather than a reason to reshape the config for every other spec.
 *
 * Not run by CI — see the note in `.github/workflows/ci.yml` on the client's
 * playwright suite. Run it with `pnpm --filter @dispatch/client e2e
 * scroll-anchoring` (needs `npx playwright install chromium webkit` once).
 */
import { test, expect, chromium, webkit, type BrowserType } from "@playwright/test";
import { probeScrollAnchoring } from "../src/lib/scrollAnchoring.js";

const ENGINES: Array<[string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

for (const [name, type] of ENGINES) {
  test.describe(`scroll anchoring probe — ${name}`, () => {
    test("reports anchoring where the engine really anchors", async () => {
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        // A page tall enough to be an ordinary document; the probe builds its
        // own scroller and needs nothing from the content.
        await page.setContent("<body style='height:2000px'>page</body>");
        expect(await page.evaluate(probeScrollAnchoring)).toBe(true);
      } finally {
        await browser.close();
      }
    });

    test("reports NO anchoring when anchoring is suppressed", async () => {
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        // `overflow-anchor: none` opts elements out as anchor candidates, which
        // is the closest a modern engine can come to impersonating iOS 18.7.
        // The probe must answer false here, or it is not measuring anything.
        await page.setContent(
          "<style>div{overflow-anchor:none!important}</style><body style='height:2000px'>page</body>",
        );
        expect(await page.evaluate(probeScrollAnchoring)).toBe(false);
      } finally {
        await browser.close();
      }
    });
  });
}
