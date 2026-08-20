/**
 * User-agent → human description, for the Active sessions list.
 *
 * Deliberately NOT a UA database (ua-parser-js and friends ship a megabyte of
 * regexes that go stale anyway). A session list only has to answer "which of my
 * devices is this?", so the goal is a confident label for the handful of engines
 * a browser session can actually arrive from, and an honest blank for anything
 * else — the raw string is always one click away in the detail modal.
 *
 * Order matters throughout: every Chromium browser still says "Chrome", Edge and
 * Opera also say "Chrome", and Safari's token appears in every WebKit UA. Each
 * list is therefore most-specific-first and the first hit wins.
 */

export type SessionDeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export interface SessionClient {
  /** e.g. "Chrome 141". Absent when nothing matched. */
  browser?: string;
  /** e.g. "Windows 11", "macOS 15", "Android 14". Absent when nothing matched. */
  os?: string;
  device: SessionDeviceKind;
  /** Rendering engine, the one thing a spoofed UA rarely lies about. */
  engine?: string;
  /** Set when the UA self-identifies as automation rather than a person. */
  bot?: boolean;
}

interface Rule {
  name: string;
  /** Must capture the version in group 1 when a version is available. */
  test: RegExp;
}

const BROWSERS: Rule[] = [
  { name: "Edge", test: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: "Opera", test: /OPR\/(\d+)/ },
  { name: "Opera", test: /Opera[ /](\d+)/ },
  { name: "Vivaldi", test: /Vivaldi\/(\d+)/ },
  { name: "Brave", test: /Brave\/(\d+)/ },
  { name: "Samsung Internet", test: /SamsungBrowser\/(\d+)/ },
  { name: "Firefox", test: /(?:Firefox|FxiOS)\/(\d+)/ },
  // Chrome on iOS is CriOS; every other Chromium shell was caught above.
  { name: "Chrome", test: /(?:CriOS|Chrome)\/(\d+)/ },
  { name: "Safari", test: /Version\/(\d+)[.\d]* Safari/ },
  { name: "Safari", test: /Safari\/(\d+)/ },
];

const ENGINES: Rule[] = [
  { name: "Blink", test: /Chrome\/(\d+)/ },
  { name: "Gecko", test: /rv:(\d+).*Gecko\// },
  { name: "WebKit", test: /AppleWebKit\/(\d+)/ },
];

/** Windows shipped no new NT version for 11 — the UA still says 10.0. */
const WINDOWS = /Windows NT (\d+)\.(\d+)/;

function version(ua: string, rule: Rule): string | undefined {
  const match = rule.test.exec(ua);
  return match ? match[1] : undefined;
}

function browser(ua: string): string | undefined {
  for (const rule of BROWSERS) {
    const found = version(ua, rule);
    if (found) return `${rule.name} ${found}`;
  }
  return undefined;
}

function engine(ua: string): string | undefined {
  for (const rule of ENGINES) if (rule.test.test(ua)) return rule.name;
  return undefined;
}

function operatingSystem(ua: string): string | undefined {
  const windows = WINDOWS.exec(ua);
  if (windows) {
    // 10 and 11 are indistinguishable here without the (rarely sent)
    // Sec-CH-UA-Platform-Version hint, so say so rather than guess wrong.
    if (windows[1] === "10") return "Windows 10/11";
    if (windows[1] === "6" && windows[2] === "3") return "Windows 8.1";
    if (windows[1] === "6" && windows[2] === "1") return "Windows 7";
    return `Windows NT ${windows[1]}.${windows[2]}`;
  }
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  const ios = /(?:iPhone )?OS (\d+)[._](\d+)(?:[._]\d+)? like Mac OS X/.exec(ua);
  if (ios) return `${/iPad/.test(ua) ? "iPadOS" : "iOS"} ${ios[1]}.${ios[2]}`;
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  // Safari freezes at 10_15_7 and Chromium at 10.15.7 on every modern macOS, so
  // anything at-or-past that ceiling gets no version rather than a false "10.15".
  if (mac) return Number(mac[1]) === 10 && Number(mac[2]) >= 15 ? "macOS" : `macOS ${mac[1]}.${mac[2]}`;
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Ubuntu/.test(ua)) return "Ubuntu";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

function device(ua: string): SessionDeviceKind {
  if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return "mobile";
  if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return "desktop";
  return "unknown";
}

/**
 * Parse a stored user-agent into the fields the session list renders. Every
 * field is optional on purpose: a blank is a truthful "we don't know", and the
 * UI falls back to the raw string rather than inventing a device name.
 */
export function describeUserAgent(ua: string | undefined): SessionClient {
  const value = (ua ?? "").trim();
  if (!value) return { device: "unknown" };
  // Non-browser callers (curl, the CLI, a health probe) hold real sessions here
  // and must not be dressed up as a browser.
  if (/\b(bot|crawler|spider|curl|wget|python-requests|node-fetch|axios|okhttp|PostmanRuntime|HeadlessChrome|Playwright|Puppeteer)\b/i.test(value)) {
    const tool = /^([^/\s]+)\/?([\d.]+)?/.exec(value);
    return {
      device: "unknown",
      bot: true,
      ...(tool?.[1] ? { browser: tool[2] ? `${tool[1]} ${tool[2].split(".")[0]}` : tool[1] } : {}),
    };
  }
  const found = browser(value);
  const os = operatingSystem(value);
  const rendering = engine(value);
  return {
    device: device(value),
    ...(found ? { browser: found } : {}),
    ...(os ? { os } : {}),
    ...(rendering ? { engine: rendering } : {}),
  };
}

/** "Chrome 141 on Windows 10/11" — the one-line label the session row shows. */
export function describeSessionClient(client: SessionClient): string {
  if (client.browser && client.os) return `${client.browser} on ${client.os}`;
  return client.browser ?? client.os ?? "Unknown client";
}
