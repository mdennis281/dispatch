import { describe, expect, it } from "vitest";
import { describeSessionClient, describeUserAgent } from "./user-agent.js";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/141.0.0.0`;
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

describe("describeUserAgent", () => {
  it("reads Chrome on Windows", () => {
    expect(describeUserAgent(CHROME_WIN)).toEqual({
      browser: "Chrome 141", os: "Windows 10/11", device: "desktop", engine: "Blink",
    });
  });

  // Every Chromium shell also claims "Chrome", so the specific token has to win.
  it("prefers Edge over the Chrome token it also carries", () => {
    expect(describeUserAgent(EDGE_WIN).browser).toBe("Edge 141");
  });

  it("reads Safari without inventing a frozen macOS version", () => {
    expect(describeUserAgent(SAFARI_MAC)).toEqual({
      browser: "Safari 18", os: "macOS", device: "desktop", engine: "WebKit",
    });
  });

  it("reads iOS Safari as a mobile device", () => {
    const client = describeUserAgent(SAFARI_IOS);
    expect(client.os).toBe("iOS 18.3");
    expect(client.device).toBe("mobile");
  });

  it("reads Firefox on Linux", () => {
    expect(describeUserAgent(FIREFOX_LINUX)).toEqual({
      browser: "Firefox 133", os: "Ubuntu", device: "desktop", engine: "Gecko",
    });
  });

  it("reads Chrome on Android as mobile", () => {
    const client = describeUserAgent(CHROME_ANDROID);
    expect(client.os).toBe("Android 14");
    expect(client.device).toBe("mobile");
  });

  it("flags non-browser callers instead of dressing them up as browsers", () => {
    const client = describeUserAgent("curl/8.9.1");
    expect(client.bot).toBe(true);
    expect(client.browser).toBe("curl 8");
  });

  it("returns an honest blank for an empty or unknown agent", () => {
    expect(describeUserAgent("")).toEqual({ device: "unknown" });
    expect(describeUserAgent(undefined)).toEqual({ device: "unknown" });
    expect(describeUserAgent("something-entirely-unknown").browser).toBeUndefined();
  });
});

describe("describeSessionClient", () => {
  it("joins browser and OS", () => {
    expect(describeSessionClient(describeUserAgent(CHROME_WIN))).toBe("Chrome 141 on Windows 10/11");
  });

  it("falls back through the fields it does have", () => {
    expect(describeSessionClient({ device: "unknown", browser: "curl 8" })).toBe("curl 8");
    expect(describeSessionClient({ device: "desktop", os: "Linux" })).toBe("Linux");
    expect(describeSessionClient({ device: "unknown" })).toBe("Unknown client");
  });
});
