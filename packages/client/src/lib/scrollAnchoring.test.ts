/**
 * Which engines are refused the row-virtualization placeholder.
 *
 * WebKit is excluded on device evidence: `probeScrollAnchoring` answered TRUE
 * on Michael's iPhone while the real transcript was shoving 3,776px
 * uncompensated in the same session. The UA string below is the ACTUAL one from
 * that trace — note `Version/27.0`, the Safari that is supposed to have scroll
 * anchoring, which is exactly why the engine's own word is no longer taken.
 *
 * Unit-tested rather than asserted in a browser because Playwright's WebKit
 * build on Windows reports a Chrome user agent, so a live browser cannot
 * exercise this branch at all.
 */
import { describe, it, expect } from "vitest";
import { isWebKitEngine } from "./scrollAnchoring.js";

const WEBKIT = [
  // Michael's iPhone, from debug-traces/2026-09-24T13-04-08-737Z.json
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  // iPad, and an older iPhone Safari
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // desktop Safari — also excluded; it loses an optimization, nothing more
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  // Every iOS browser is WKWebView underneath, so the branded ones share Mobile
  // Safari's behaviour exactly and must be excluded WITH it. An earlier version
  // of this predicate listed `CriOS`/`Edg` as Chromium and let all three of
  // these through to the probe — on the one platform the evidence came from.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/604.1",
];

const NOT_WEBKIT = [
  // Chromium says AppleWebKit AND Safari; the exclusions carry the test
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  // Edge and Opera on DESKTOP are Chromium and keep the optimization
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0",
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0",
];

describe("isWebKitEngine", () => {
  it.each(WEBKIT)("excludes %s", (ua) => expect(isWebKitEngine(ua)).toBe(true));
  it.each(NOT_WEBKIT)("allows %s", (ua) => expect(isWebKitEngine(ua)).toBe(false));
});
