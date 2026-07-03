/** Small, dependency-free formatting helpers used across the UI. */

/** "3m ago", "just now", "2h ago" — compact relative time from an epoch-ms. */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** "HH:MM" 24h clock for transcript timestamps. */
export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** "1.2s", "840ms" — human tool durations. */
export function dur(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** Split an `mcp__<server>__<tool>` name into its parts. */
export function parseMcpName(
  name: string,
): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!m) return null;
  return { server: m[1]!, tool: m[2]! };
}

/** Pretty short label for any tool name (Bash, Write, chrome › navigate…). */
export function toolLabel(name: string): string {
  const mcp = parseMcpName(name);
  if (mcp) return `${mcp.server} › ${mcp.tool}`;
  return name;
}

/** Truncate the middle of a long path, keeping head + tail. */
export function midTruncate(s: string, max = 42): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** JSON pretty-print that never throws. */
export function safeJson(v: unknown, space = 2): string {
  try {
    return JSON.stringify(v, null, space);
  } catch {
    return String(v);
  }
}
