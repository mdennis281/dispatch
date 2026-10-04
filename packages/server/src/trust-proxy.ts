/**
 * Who is allowed to tell us the client's address.
 *
 * Dispatch reads `req.ip` for the Active sessions list and `req.protocol` for
 * the refresh cookie's `Secure` attribute. Both come from the SOCKET unless
 * Fastify is told otherwise, so an install behind a reverse proxy (HAProxy on
 * pfSense, nginx, Caddy, Cloudflare Tunnel…) sees every session arrive from the
 * proxy's own LAN address — one row per device, all claiming 10.0.0.1, which is
 * exactly the signal the session list exists to give you.
 *
 * The fix is `X-Forwarded-For`, and it is OFF by default on purpose: that header
 * is client-supplied. Trusting it unconditionally while host mode is on lets
 * anyone who can reach the port directly write their own session IP — and flip
 * `req.protocol` to `https`, which would put `Secure` on a cookie travelling in
 * clear text, so the browser silently drops it on the next plaintext request.
 * Naming the proxy's address is therefore the documented form; `true` exists for
 * deployments where nothing but the proxy can route to the port at all.
 */

/**
 * What Fastify's `trustProxy` option accepts, minus the predicate form.
 *
 * No hop count. proxy-addr would take one, but `FastifyServerOptions` does not
 * type it, and an untyped form is not worth supporting when naming the proxy is
 * both stricter and the thing we want people to do anyway.
 */
export type TrustProxy = boolean | string[];

const OFF = new Set(["false", "0", "off", "no"]);
const ON = new Set(["true", "on", "yes"]);
/** proxy-addr's own names for address ranges, accepted verbatim. */
const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
/** Deliberately loose — proxy-addr does the real parse; this only catches typos. */
const IPV6 = /^[0-9a-f:.]+(?:\/\d{1,3})?$/i;

function validEntry(entry: string): boolean {
  const lower = entry.toLowerCase();
  if (KEYWORDS.has(lower)) return true;
  const v4 = IPV4.exec(entry);
  if (v4) {
    const octets = [v4[1]!, v4[2]!, v4[3]!, v4[4]!].map(Number);
    if (octets.some((n) => n > 255)) return false;
    return v4[5] === undefined || Number(v4[5]) <= 32;
  }
  if (!entry.includes(":")) return false;
  const [address, bits] = entry.split("/", 2);
  if (!IPV6.test(entry) || !address) return false;
  return bits === undefined || Number(bits) <= 128;
}

function entries(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

/**
 * Why `raw` is unusable, or `null` if it is fine. Separate from the parse
 * because the two callers want opposite things from a bad value: the HTTP
 * endpoint rejects it with the reason, while boot must only skip it. A typo
 * handed straight to proxy-addr THROWS inside the Fastify constructor, which
 * would turn "I mistyped a subnet in Settings" into a server that won't start.
 */
export function trustProxyError(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (OFF.has(lower) || ON.has(lower)) return null;
  // A bare number is a proxy-addr hop count. Named rather than silently
  // ignored, because someone typing `1` has a clear intent and deserves to be
  // told the supported spelling of it rather than wonder why nothing changed.
  if (/^\d+$/.test(value)) return "a hop count is not supported — name the proxy's address instead";
  const bad = entries(value).filter((entry) => !validEntry(entry));
  if (bad.length) return `not an IP address, CIDR range or keyword: ${bad.join(", ")}`;
  return null;
}

/**
 * Raw setting → Fastify's `trustProxy`. `undefined` means "say nothing", which
 * leaves Fastify at its own default of `false`.
 *
 * Accepted: `true`/`on`/`yes`, `false`/`off`/`no`/`0`, or a comma-separated list
 * of addresses, CIDR ranges and proxy-addr keywords. Anything else resolves to
 * `undefined` rather than throwing — see `trustProxyError`.
 */
export function parseTrustProxy(raw: string | undefined | null): TrustProxy | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (OFF.has(lower)) return false;
  if (ON.has(lower)) return true;
  if (trustProxyError(value)) return undefined;
  const list = entries(value);
  return list.length ? list : undefined;
}

/**
 * What is actually being trusted, in words — empty when that is nobody.
 *
 * Derived from `parseTrustProxy` rather than from the raw string, because the
 * raw string lies about this in both directions: `off` is a VALID value that
 * trusts nobody, and a validation failure trusts nobody either. Reading the
 * input instead of the outcome printed `trusting X-Forwarded-For from off` at
 * boot and "Trusting `off`" in Settings while Fastify had `trustProxy: false`.
 *
 * Also the comparison key for "has the saved setting diverged from the running
 * process", so it must be canonical: `10.0.0.1` and ` 10.0.0.1 ` are one
 * answer, and a restart notice must not appear because of a space.
 */
export function describeTrustProxy(raw: string | undefined | null): string {
  const parsed = parseTrustProxy(raw);
  if (parsed === true) return "any upstream";
  if (!parsed) return "";
  return parsed.join(", ");
}
