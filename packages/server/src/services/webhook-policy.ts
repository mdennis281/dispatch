/**
 * Who may do what to a webhook subscription, and where one may point.
 *
 * Pure functions, separated from `WebhookService` so the rules can be tested
 * without a bus or a store, and so the route layer and the service enforce ONE
 * copy of them.
 *
 * Two callers exist. A browser session is the owner at their own machine and
 * may target anything, including the LAN: a self-hosted ntfy on 192.168.x is
 * the whole point. An integration token (workstream B) is a narrower grant,
 * and `webhooks:manage` must not become a way around the token's other limits
 * — a token scoped to one project cannot subscribe to every project's events,
 * a token without `chats:read` cannot receive transcript rows, and a token
 * cannot aim Dispatch at `http://127.0.0.1:4318/api/...` and turn it into a
 * request proxy for the network it is not on.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { WebhookFilter, WebhookSubscription } from "@dispatch/shared";

/** Thrown by the policy and the service; the route maps `status` to the reply. */
export class WebhookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

/**
 * The caller, as the webhook layer sees it.
 *
 * Derived from `req.authIdentity` by {@link callerFromIdentity}. Until
 * workstream B lands, every authenticated request is a browser session and
 * `kind` is absent on the identity; the derivation treats that as `user`.
 */
export type WebhookCaller =
  | { kind: "user" }
  | {
      kind: "integration";
      tokenId: string;
      scopes: readonly string[];
      /** The token's project bound; absent means every project. */
      projectIds?: readonly string[];
    };

/** The scope that lets a token manage subscriptions at all. */
export const WEBHOOKS_MANAGE_SCOPE = "webhooks:manage";

/**
 * Which read scope each event needs before a TOKEN may subscribe to it. An
 * event absent from this table is not available to a token at all — the
 * remaining wire events describe this machine (terminals, runners, worktrees,
 * usage, updates), which no integration scope covers.
 */
export const WEBHOOK_EVENT_SCOPES: Readonly<Record<string, string>> = {
  "chat-message": "chats:read",
  "chat-status": "chats:read",
  "chat-update": "chats:read",
  "chat-deleted": "chats:read",
  "chat-settled": "chats:read",
  "attention-add": "attention:read",
  "attention-resolve": "attention:read",
  "permission-request": "attention:read",
  "pr-update": "projects:read",
  "pr-record-update": "projects:read",
  "project-update": "projects:read",
  "memory-update": "memory:read",
  "memory-deleted": "memory:read",
};

/**
 * Read the caller off whatever the auth gate attached to the request.
 *
 * Typed loosely on purpose: `RequestIdentity` gains `kind`/`tokenId`/`scopes`
 * in workstream B, and this module must compile — and treat every caller as a
 * browser session — both before and after that lands.
 */
export function callerFromIdentity(identity: unknown): WebhookCaller {
  const id = identity as
    | { kind?: unknown; tokenId?: unknown; scopes?: unknown; projectIds?: unknown }
    | undefined;
  if (id?.kind !== "integration" || typeof id.tokenId !== "string") return { kind: "user" };
  const scopes = Array.isArray(id.scopes) ? id.scopes.filter((s) => typeof s === "string") : [];
  const projectIds = Array.isArray(id.projectIds)
    ? id.projectIds.filter((p): p is string => typeof p === "string")
    : undefined;
  return { kind: "integration", tokenId: id.tokenId, scopes, projectIds };
}

/** `createdBy` for a subscription this caller makes. */
export function createdByFor(caller: WebhookCaller): string {
  return caller.kind === "user" ? "user" : caller.tokenId;
}

/** Refuse a token that lacks `webhooks:manage`; a session always passes. */
export function assertMayManage(caller: WebhookCaller): void {
  if (caller.kind === "integration" && !caller.scopes.includes(WEBHOOKS_MANAGE_SCOPE)) {
    throw new WebhookError(403, `Missing scope: ${WEBHOOKS_MANAGE_SCOPE}`);
  }
}

/**
 * Whether this caller may see or touch `sub`. A session sees everything; a
 * token sees only what it created. The service answers 404 rather than 403 for
 * a foreign subscription so a token cannot enumerate the owner's.
 */
export function mayAccess(caller: WebhookCaller, sub: Pick<WebhookSubscription, "createdBy">): boolean {
  return caller.kind === "user" || sub.createdBy === caller.tokenId;
}

/**
 * Narrow a filter to what a token is allowed to receive. Identity for a
 * session.
 *
 * Projects: intersected with the token's list, and an UNSET filter becomes the
 * token's list — never "all", which is what unset means for a session.
 *
 * Events: refused, not silently narrowed. A token asking for `chat-message`
 * without `chats:read` is told which scope it lacks, the same answer
 * `requireScope` gives on the REST surface, rather than being handed a
 * subscription that quietly never fires. An unset list becomes every event the
 * token's scopes cover.
 */
export function boundFilterFor(caller: WebhookCaller, filter: WebhookFilter): WebhookFilter {
  if (caller.kind === "user") return filter;
  const out: WebhookFilter = { ...filter };

  const allowed = Object.entries(WEBHOOK_EVENT_SCOPES)
    .filter(([, scope]) => caller.scopes.includes(scope))
    .map(([event]) => event);
  if (allowed.length === 0) {
    throw new WebhookError(403, "This token has no read scope that any webhook event falls under.");
  }
  if (filter.events?.length) {
    for (const event of filter.events) {
      const scope = WEBHOOK_EVENT_SCOPES[event];
      if (!scope) throw new WebhookError(403, `Event "${event}" is not available to integration tokens.`);
      if (!caller.scopes.includes(scope)) throw new WebhookError(403, `Missing scope: ${scope}`);
    }
  } else {
    out.events = allowed as WebhookFilter["events"];
  }

  if (caller.projectIds) {
    const own = new Set(caller.projectIds);
    const wanted = filter.projectIds?.length ? filter.projectIds.filter((p) => own.has(p)) : [...own];
    if (wanted.length === 0) {
      throw new WebhookError(400, "None of the requested projects are within this token's grant.");
    }
    out.projectIds = wanted;
  }
  return out;
}

/* ------------------------------------------------------ public addresses */

/**
 * Is this literal IP one a token-created webhook must never reach?
 *
 * Loopback, link-local, RFC 1918, the unspecified address, IPv6 ULA, and the
 * IPv4-mapped forms of all of them — every range a request from this host
 * would answer from inside the owner's network.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // not an address at all — refuse rather than guess
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (RFC 6598)
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]!; // drop a zone id
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  return false;
}

/** Resolver seam: the real one is `dns.lookup`; tests hand in a table. */
export type HostResolver = (host: string) => Promise<string[]>;

export const resolveHostAddresses: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/**
 * The URL a TOKEN-created subscription may use: `https:`, and a host that
 * resolves only to public addresses.
 *
 * Checked at creation AND before every delivery attempt, because a name is not
 * an address: a DNS record pointing at a public host when the subscription was
 * made can be repointed at `127.0.0.1` afterwards. The check and the fetch
 * resolve separately, so a record flipped between the two still gets through
 * once; closing that needs a pinned-address HTTP client and is not v1.
 */
export async function assertPublicUrl(url: string, resolve: HostResolver = resolveHostAddresses): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookError(400, "Webhook URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new WebhookError(400, "A token-created webhook must use https.");
  }
  // `URL` keeps IPv6 literals bracketed.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new WebhookError(400, "A token-created webhook may not target this machine.");
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (addresses.length === 0) {
    throw new WebhookError(400, `Webhook host "${host}" did not resolve.`);
  }
  if (addresses.some(isPrivateAddress)) {
    throw new WebhookError(400, `Webhook host "${host}" resolves to a private address.`);
  }
}
