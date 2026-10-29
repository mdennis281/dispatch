/**
 * INTEGRATION TOKENS, SERVER SIDE — the live half of what the CLI core persists.
 *
 * `AuthService` owns an instance of this and exposes it as `auth.tokens`. It is
 * a separate class rather than more methods on the (already 1100-line) auth
 * service because its concerns are its own: a bearer that is not a session,
 * a rate limit the sessions don't have, and a file the CLI edits underneath us.
 *
 * THE FILE IS SHARED WITH `dispatch token`. So every read goes through a stamp check
 * (mtime + size + inode, the same trick `auth.json` uses) and reloads when the
 * CLI has written, and every write takes the CLI's lock and re-reads before
 * mutating. Without that a `dispatch token create` while the server is up either
 * never authenticates (server holds a stale list) or is clobbered by the next
 * `lastUsedAt` flush (server writes its stale list back). Both were observed in
 * design and neither errors, which is why the discipline is total.
 *
 * NEVER log the token value. It passes through {@link authenticate} as a
 * function argument and is hashed on the first line.
 */
import { stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  INTEGRATION_RATE_LIMIT_PER_MINUTE,
  type IntegrationScope,
  type IntegrationTokenCreateRequest,
  type IntegrationTokenSummary,
  type IntegrationTrust,
} from "@dispatch/shared";
import {
  hashIntegrationToken,
  isIntegrationTokenShape,
  mintIntegrationToken,
  readIntegrationTokenFile,
  summarizeIntegrationToken,
  trustOf,
  withIntegrationTokenLock,
  writeIntegrationTokenFile,
  type StoredIntegrationToken,
} from "@dispatch/cli/core";

/**
 * What the gate stamps on a request a token authenticated. `kind` is the
 * discriminant every route reads before touching `user` or `scopes` — a browser
 * session is `kind: "user"` (see `RequestIdentity` in auth.ts).
 */
export interface IntegrationIdentity {
  kind: "integration";
  tokenId: string;
  name: string;
  scopes: IntegrationScope[];
  /** When set, the only projects this caller may see. Absent = every project. */
  projectIds?: string[];
  /**
   * Whose words this caller's messages are. Read off the token row on every
   * request, so an owner flipping it in Settings takes effect on the bot's
   * next message, not its next token.
   */
  trust: IntegrationTrust;
}

/**
 * How long a `lastUsedAt` stamp may sit in memory before it reaches disk. The
 * same reasoning as the session file's last-seen debounce: a bot polling every
 * second must not cost an atomic file rewrite per request.
 */
const LAST_USED_FLUSH_MS = 60_000;

const RATE_WINDOW_MS = 60_000;

export class IntegrationTokenService {
  private data: { version: 1; tokens: StoredIntegrationToken[] } | null = null;
  private stamp: string | null = null;
  private loading: Promise<void> | null = null;
  /** Token id → epoch-ms of its requests inside the current window. */
  private readonly hits = new Map<string, number[]>();
  /** Token ids whose `lastUsedAt` moved in memory and are not yet on disk. */
  private readonly dirtyUsed = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly perMinute = INTEGRATION_RATE_LIMIT_PER_MINUTE,
  ) {}

  /* --------------------------------------------------------------- loading */

  private async readStamp(): Promise<string | null> {
    try {
      const info = await stat(this.path, { bigint: true });
      return `${info.mtimeNs}:${info.size}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Load, or reload if the CLI (or another instance) has written since. */
  private async load(): Promise<StoredIntegrationToken[]> {
    if (this.loading) await this.loading;
    const stamp = await this.readStamp();
    if (!this.data || stamp !== this.stamp) {
      this.loading = (async () => {
        this.data = await readIntegrationTokenFile(this.path);
        this.stamp = stamp;
        // A reload must not lose a stamp that was still in memory: re-apply it
        // onto the fresh rows so the next flush carries it.
        for (const row of this.data.tokens) {
          const pending = this.dirtyUsed.get(row.id);
          if (pending !== undefined && (row.lastUsedAt ?? 0) < pending) row.lastUsedAt = pending;
        }
      })().finally(() => {
        this.loading = null;
      });
      await this.loading;
    }
    return this.data!.tokens;
  }

  /* --------------------------------------------------------- authenticate */

  /**
   * Resolve a bearer to an identity, or null. `authEpoch` is the current one
   * from `auth.json`: a token minted under an older epoch was implicitly
   * revoked when authentication was turned off (see `AuthService.disable`).
   *
   * `expiresAt` is checked here rather than scrubbed from the file, so the
   * Settings list can still show an expired token as expired.
   */
  async authenticate(token: string | undefined, authEpoch: number): Promise<IntegrationIdentity | null> {
    if (!isIntegrationTokenShape(token)) return null;
    const hash = hashIntegrationToken(token);
    const rows = await this.load();
    const now = this.now();
    for (const row of rows) {
      if (!safeEqual(row.hash, hash)) continue;
      if (row.revokedAt !== undefined) return null;
      if (row.authEpoch !== authEpoch) return null;
      if (row.expiresAt !== undefined && row.expiresAt <= now) return null;
      this.touch(row, now);
      return {
        kind: "integration",
        tokenId: row.id,
        name: row.name,
        scopes: row.scopes,
        ...(row.projectIds?.length ? { projectIds: row.projectIds } : {}),
        trust: trustOf(row),
      };
    }
    return null;
  }

  private touch(row: StoredIntegrationToken, now: number): void {
    if (row.lastUsedAt !== undefined && now - row.lastUsedAt < 1_000) return;
    row.lastUsedAt = now;
    this.dirtyUsed.set(row.id, now);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushUsed().catch(() => {});
    }, LAST_USED_FLUSH_MS);
    // Never hold the process open for a timestamp.
    this.flushTimer.unref?.();
  }

  /**
   * Land pending `lastUsedAt` stamps. Under the lock, onto a FRESH read: the CLI
   * may have minted since we loaded, and writing our in-memory list back would
   * delete its row.
   */
  private async flushUsed(): Promise<void> {
    if (!this.dirtyUsed.size) return;
    const pending = new Map(this.dirtyUsed);
    this.dirtyUsed.clear();
    await withIntegrationTokenLock(this.path, async () => {
      const fresh = await readIntegrationTokenFile(this.path);
      let changed = false;
      for (const row of fresh.tokens) {
        const at = pending.get(row.id);
        if (at !== undefined && (row.lastUsedAt ?? 0) < at) {
          row.lastUsedAt = at;
          changed = true;
        }
      }
      if (changed) await writeIntegrationTokenFile(this.path, fresh);
      this.data = fresh;
      this.stamp = await this.readStamp();
    });
  }

  /** Flush what is pending (server close). */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushUsed().catch(() => {});
  }

  /* ------------------------------------------------------------ rate limit */

  /**
   * One sliding window per token. Returns null when the request may proceed,
   * else the whole seconds until the oldest hit ages out — the `Retry-After`
   * the gate sends with its 429. Counted on the way IN rather than after the
   * handler, so a flood of expensive calls is refused before it costs anything.
   */
  checkRate(tokenId: string): number | null {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    const kept = (this.hits.get(tokenId) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.perMinute) {
      this.hits.set(tokenId, kept);
      return Math.max(1, Math.ceil((kept[0]! + RATE_WINDOW_MS - now) / 1000));
    }
    kept.push(now);
    this.hits.set(tokenId, kept);
    return null;
  }

  /* ------------------------------------------------------------ management */

  async list(): Promise<IntegrationTokenSummary[]> {
    return (await this.load()).map(summarizeIntegrationToken);
  }

  /** Mint. The caller has already established that auth is enabled. */
  async mint(
    input: IntegrationTokenCreateRequest,
    opts: { authEpoch: number; clientId?: string },
  ): Promise<{ token: string; summary: IntegrationTokenSummary }> {
    const { token, row } = await mintIntegrationToken(this.path, input, {
      authEpoch: opts.authEpoch,
      now: this.now,
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    });
    // Drop the cache so the next authenticate sees the row at once rather than
    // whenever the stamp happens to be re-read.
    this.data = null;
    return { token, summary: summarizeIntegrationToken(row) };
  }

  /**
   * Change a token's trust in place. Allowed on any row the file still holds —
   * revoked included, harmlessly — and returns the new summary, or null when
   * no such id. The default level is stored as ABSENT, so lowering a token
   * leaves its row exactly as an ordinary one reads.
   */
  async setTrust(id: string, trust: IntegrationTrust): Promise<IntegrationTokenSummary | null> {
    const summary = await withIntegrationTokenLock(this.path, async () => {
      const fresh = await readIntegrationTokenFile(this.path);
      const row = fresh.tokens.find((t) => t.id === id);
      if (!row) return null;
      if (trust === "owner") row.trust = trust;
      else delete row.trust;
      await writeIntegrationTokenFile(this.path, fresh);
      return summarizeIntegrationToken(row);
    });
    this.data = null;
    return summary;
  }

  async revoke(id: string): Promise<boolean> {
    const now = this.now();
    const found = await withIntegrationTokenLock(this.path, async () => {
      const fresh = await readIntegrationTokenFile(this.path);
      const row = fresh.tokens.find((t) => t.id === id);
      if (!row) return false;
      if (row.revokedAt === undefined) {
        row.revokedAt = now;
        await writeIntegrationTokenFile(this.path, fresh);
      }
      return true;
    });
    this.data = null;
    return found;
  }

  /**
   * DELETE a row, as opposed to {@link revoke}, which keeps it. For a token
   * nobody was ever shown — an OAuth access token a rotation has superseded,
   * whose grant row is the audit record. A hand-minted token is never removed
   * this way: its "revoked" row is what tells the person who minted it why
   * their bot stopped working.
   */
  async remove(id: string): Promise<boolean> {
    const found = await withIntegrationTokenLock(this.path, async () => {
      const fresh = await readIntegrationTokenFile(this.path);
      const before = fresh.tokens.length;
      fresh.tokens = fresh.tokens.filter((t) => t.id !== id);
      if (fresh.tokens.length === before) return false;
      await writeIntegrationTokenFile(this.path, fresh);
      return true;
    });
    this.data = null;
    this.dirtyUsed.delete(id);
    return found;
  }

  /** Revoke every live token — what turning authentication off does. */
  async revokeAll(): Promise<number> {
    const now = this.now();
    const count = await withIntegrationTokenLock(this.path, async () => {
      const fresh = await readIntegrationTokenFile(this.path);
      let n = 0;
      for (const row of fresh.tokens) {
        if (row.revokedAt === undefined) {
          row.revokedAt = now;
          n++;
        }
      }
      if (n) await writeIntegrationTokenFile(this.path, fresh);
      return n;
    });
    this.data = null;
    return count;
  }
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/* ----------------------------------------------------------------- routes */

/** The identity a request carries, whichever gate stamped it. */
export type AnyIdentity = IntegrationIdentity | { kind: "user"; [k: string]: unknown };

/** Thrown by {@link requireScope}; routes answer it as the status it names. */
export class ScopeFailure extends Error {
  constructor(
    public status: number,
    message: string,
    public scope?: IntegrationScope,
  ) {
    super(message);
  }
}

/**
 * The scopes a request effectively holds. A browser session (and a request on
 * an install with auth off, which has no identity at all because the gate
 * never ran) holds every scope: the integration surface is a CURATED view of
 * what the SPA can already do, not a privilege above it.
 */
export function integrationIdentity(req: FastifyRequest): IntegrationIdentity | undefined {
  const id = req.authIdentity as AnyIdentity | undefined;
  return id?.kind === "integration" ? id : undefined;
}

/**
 * Refuse a request whose token lacks `scope`. Names the missing scope in the
 * body so a bot's author can fix the token rather than guess which of eight
 * grants the route wanted.
 */
export function requireScope(req: FastifyRequest, scope: IntegrationScope): void {
  const id = integrationIdentity(req);
  if (!id) return;
  if (!id.scopes.includes(scope)) {
    throw new ScopeFailure(403, `This token does not have the "${scope}" scope.`, scope);
  }
}

/**
 * Whether a project is inside the caller's allowlist. `undefined` project (a
 * chat with none) is visible only to an unrestricted caller.
 */
export function projectAllowed(req: FastifyRequest, projectId: string | undefined): boolean {
  const id = integrationIdentity(req);
  if (!id?.projectIds) return true;
  return projectId !== undefined && id.projectIds.includes(projectId);
}

/** Send a {@link ScopeFailure} as its status, with the scope named. */
export function sendScopeFailure(reply: FastifyReply, error: ScopeFailure): FastifyReply {
  return reply
    .code(error.status)
    .send({ error: error.message, ...(error.scope ? { scope: error.scope } : {}) });
}
