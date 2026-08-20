/**
 * IP → network description for the Active sessions list.
 *
 * Two halves, and the split is the point:
 *   - `classifyIp` is local, total, and always runs. Loopback and RFC1918
 *     addresses get named as such and NEVER leave the machine, which is most of
 *     what a self-hosted Dispatch sees.
 *   - the lookup is a call to a third party, only ever for a public address, and
 *     the human can turn it off (Settings → Authentication). Default-on because
 *     an unrecognised public IP in your session list is exactly the case where
 *     "which ISP, which city" is the answer you need.
 *
 * Failures are values, not throws: a session row must still render when the
 * provider is down, rate-limiting, or unreachable because this box has no
 * outbound internet at all.
 */
import type { SessionNetwork, SessionNetworkScope } from "@dispatch/shared";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** ipwho.is: no key, HTTPS, and reports connection.isp — which the free tier of
 *  ip-api.com only serves over plaintext HTTP. */
const ENDPOINT = (ip: string) => `https://ipwho.is/${encodeURIComponent(ip)}`;
const LOOKUP_TIMEOUT_MS = 4_000;
/** An IP's owner changes on the order of months; a day is plenty fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed lookup retries soon, but not on every settings page load. */
const ERROR_TTL_MS = 10 * 60 * 1000;

interface CacheEntry { value: SessionNetwork; expiresAt: number }

/** Strip the ::ffff: prefix Node puts on IPv4 seen through a dual-stack socket. */
function normalize(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return (mapped ? mapped[1]! : ip.trim()).replace(/^\[|\]$/g, "");
}

export function classifyIp(raw: string | undefined): SessionNetworkScope {
  if (!raw) return "unknown";
  const ip = normalize(raw).toLowerCase();
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.")) return "loopback";
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return "private";
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return "private";
    // Link-local (APIPA) and CGNAT are equally un-geolocatable.
    if ((a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  return ip.includes(":") ? "public" : "unknown";
}

interface WhoisResponse {
  success?: boolean;
  message?: string;
  city?: string;
  region?: string;
  country?: string;
  country_code?: string;
  connection?: { isp?: string; org?: string };
  timezone?: { id?: string };
}

export class IpGeo {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<SessionNetwork>>();
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: (ip: string) => string;
  private readonly now: () => number;

  constructor(deps: { fetch?: FetchLike; endpoint?: (ip: string) => string; now?: () => number } = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.endpoint = deps.endpoint ?? ENDPOINT;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Describe one address. `lookup: false` (the opt-out setting, or any
   * non-public address) short-circuits to the local classification with no
   * outbound request at all.
   */
  async describe(ip: string | undefined, lookup: boolean): Promise<SessionNetwork> {
    const scope = classifyIp(ip);
    if (!lookup || scope !== "public" || !ip) return { scope };
    const key = normalize(ip);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    // Several sessions routinely share one public IP; one flight serves them all.
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const flight = this.lookup(key, scope).finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  private async lookup(ip: string, scope: SessionNetworkScope): Promise<SessionNetwork> {
    let value: SessionNetwork;
    try {
      // AbortSignal.timeout rather than a bare await: the settings panel blocks
      // on this, and a provider that never answers must not hang the request.
      const response = await this.fetchImpl(this.endpoint(ip), { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`lookup returned ${response.status}`);
      const body = await response.json() as WhoisResponse;
      if (body.success === false) throw new Error(body.message || "lookup failed");
      value = {
        scope,
        lookedUpAt: this.now(),
        ...(body.connection?.isp ? { isp: body.connection.isp } : {}),
        ...(body.connection?.org && body.connection.org !== body.connection.isp ? { org: body.connection.org } : {}),
        ...(body.city ? { city: body.city } : {}),
        ...(body.region ? { region: body.region } : {}),
        ...(body.country ? { country: body.country } : {}),
        ...(body.country_code ? { countryCode: body.country_code } : {}),
        ...(body.timezone?.id ? { timezone: body.timezone.id } : {}),
      };
    } catch (error) {
      value = { scope, lookedUpAt: this.now(), error: error instanceof Error ? error.message : String(error) };
    }
    this.cache.set(ip, { value, expiresAt: this.now() + (value.error ? ERROR_TTL_MS : CACHE_TTL_MS) });
    return value;
  }
}
