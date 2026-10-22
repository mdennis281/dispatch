/**
 * THE INTEGRATION TOKEN FILE — minting, listing and revoking `dsp_` tokens
 * against `<dataDir>/integration-tokens.json`.
 *
 * Lives in the CLI core rather than the server for the same reason the MCP
 * config core does: two processes write this file. The server mints from
 * Settings → Integrations, and `cm token create` mints OFFLINE — there is no
 * credential a terminal could present to the server's HTTP surface that is not
 * itself one of these tokens, so the first token on an install has to be made
 * without one. Both go through these functions, so the format, the hash and the
 * lock cannot drift between them.
 *
 * WHY A LOCK AND A RELOAD. The server holds the file in memory (it checks every
 * integration request against it) and the CLI edits it underneath. Without the
 * lock a CLI mint racing a server `lastUsedAt` flush is a read-modify-write
 * collision and one of the two tokens vanishes with no error. Every mutation
 * here therefore takes the lock, RE-READS, mutates, and writes atomically; the
 * server does the same for its own writes and re-reads the file whenever its
 * mtime moves. The lock is the mkdir-based one `auth.json` uses, kept in step by
 * hand: a shared implementation would have to live in a package both the server
 * and the CLI import from, and today this core is the only such place.
 *
 * NEVER log, print or persist the token value anywhere but the one return value
 * of {@link mintIntegrationToken}. The file holds its SHA-256 only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  INTEGRATION_TOKEN_NAME_MAX,
  INTEGRATION_TOKEN_PREFIX,
  parseIntegrationScopes,
  type IntegrationScope,
  type IntegrationTokenCreateRequest,
  type IntegrationTokenSummary,
} from "@dispatch/shared";
import { CmError } from "./manifest.js";

/** One token at rest. The hash, never the value. */
export interface StoredIntegrationToken {
  id: string;
  /** base64url SHA-256 of the full token string, prefix included. */
  hash: string;
  name: string;
  scopes: IntegrationScope[];
  projectIds?: string[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  /** Reserved for OAuth (workstream F). */
  clientId?: string;
  /**
   * The auth epoch the token was minted under. `AuthService` bumps the epoch
   * when authentication is turned off, which is how "disabling auth revokes
   * every token" holds even for a token minted offline while the server was
   * down and never saw the explicit revoke.
   */
  authEpoch: number;
}

export interface IntegrationTokenFile {
  version: 1;
  tokens: StoredIntegrationToken[];
}

/** File name under the DATA dir — per instance, beside `auth-sessions.json`. */
export const INTEGRATION_TOKENS_FILE = "integration-tokens.json";

export function integrationTokensPath(dataDir: string): string {
  return join(dataDir, INTEGRATION_TOKENS_FILE);
}

/** `dsp_` + 32 random bytes, base64url: 47 characters, no padding. */
export function generateIntegrationToken(): string {
  return `${INTEGRATION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashIntegrationToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function isIntegrationTokenShape(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(INTEGRATION_TOKEN_PREFIX);
}

export function summarizeIntegrationToken(row: StoredIntegrationToken): IntegrationTokenSummary {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    ...(row.projectIds ? { projectIds: row.projectIds } : {}),
    createdAt: row.createdAt,
    ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
    ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
    ...(row.clientId !== undefined ? { clientId: row.clientId } : {}),
  };
}

/* ------------------------------------------------------------- the file */

export async function readIntegrationTokenFile(path: string): Promise<IntegrationTokenFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tokens: [] };
    throw error;
  }
  if (!raw.trim()) return { version: 1, tokens: [] };
  const parsed = JSON.parse(raw) as Partial<IntegrationTokenFile>;
  return parsed.version === 1 && Array.isArray(parsed.tokens)
    ? { version: 1, tokens: parsed.tokens }
    : { version: 1, tokens: [] };
}

/** Atomic: tmp + rename, mode 0600 like the session file. */
export async function writeIntegrationTokenFile(
  path: string,
  data: IntegrationTokenFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

const LOCK_WAIT_MS = 5_000;

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Cross-process mutual exclusion on the token file. Mirrors the auth-file lock:
 * `mkdir` is atomic on every filesystem Node runs on, and the owner record lets
 * a lock left behind by a crashed process be recovered rather than waited on
 * forever.
 */
export async function withIntegrationTokenLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const lockDir = `${path}.lock`;
  const ownerFile = join(lockDir, "owner.json");
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerFile, JSON.stringify({ pid: process.pid, nonce, acquiredAt: Date.now() }), {
          mode: 0o600,
        });
      } catch (error) {
        await rmdir(lockDir).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { pid?: unknown };
        stale = typeof owner.pid === "number" && !(await processIsAlive(owner.pid));
      } catch {
        try {
          stale = Date.now() - (await stat(lockDir)).mtimeMs > 1_000;
        } catch {
          continue;
        }
      }
      if (stale) {
        const quarantine = `${lockDir}.stale-${randomUUID()}`;
        try {
          await rename(lockDir, quarantine);
          await unlink(join(quarantine, "owner.json")).catch(() => {});
          await rmdir(quarantine).catch(() => {});
        } catch (renameError) {
          const code = (renameError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST") throw renameError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CmError("integration token file is busy; try again shortly");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await task();
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { nonce?: unknown };
        if (owner.nonce !== nonce) break;
        await unlink(ownerFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(lockDir);
        break;
      } catch {
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

/* --------------------------------------------------------------- mutations */

export interface MintOptions {
  /** The current auth epoch — see {@link StoredIntegrationToken.authEpoch}. */
  authEpoch: number;
  now?: () => number;
  /** Reserved for OAuth (workstream F): the grant's client, stamped on the row. */
  clientId?: string;
}

/**
 * Validate a create request into the row it would store, WITHOUT the hash —
 * shared by the server route and the CLI so both reject the same inputs with
 * the same words.
 */
export function validateIntegrationTokenRequest(
  input: IntegrationTokenCreateRequest,
  now: number,
): Omit<StoredIntegrationToken, "id" | "hash" | "authEpoch" | "createdAt"> {
  const name = input.name?.trim() ?? "";
  if (!name) throw new CmError("a token needs a name");
  if (name.length > INTEGRATION_TOKEN_NAME_MAX) {
    throw new CmError(`token name must be at most ${INTEGRATION_TOKEN_NAME_MAX} characters`);
  }
  const scopes = parseIntegrationScopes(input.scopes ?? []);
  if (!scopes.ok) throw new CmError(`unknown scope(s): ${scopes.unknown.join(", ")}`);
  if (!scopes.scopes.length) throw new CmError("a token needs at least one scope");
  const projectIds = input.projectIds?.map((p) => p.trim()).filter(Boolean);
  if (input.expiresAt !== undefined) {
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new CmError("expiry must be a future time");
    }
  }
  return {
    name,
    scopes: scopes.scopes,
    ...(projectIds?.length ? { projectIds: [...new Set(projectIds)] } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

/**
 * Mint a token into `path`. The returned `token` is the ONLY copy of the value
 * that will ever exist; the file keeps its hash.
 */
export async function mintIntegrationToken(
  path: string,
  input: IntegrationTokenCreateRequest,
  opts: MintOptions,
): Promise<{ token: string; row: StoredIntegrationToken }> {
  const now = (opts.now ?? Date.now)();
  const fields = validateIntegrationTokenRequest(input, now);
  const token = generateIntegrationToken();
  const row: StoredIntegrationToken = {
    id: randomUUID(),
    hash: hashIntegrationToken(token),
    ...fields,
    createdAt: now,
    authEpoch: opts.authEpoch,
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
  };
  await withIntegrationTokenLock(path, async () => {
    const data = await readIntegrationTokenFile(path);
    data.tokens.push(row);
    await writeIntegrationTokenFile(path, data);
  });
  return { token, row };
}

export async function listIntegrationTokens(path: string): Promise<StoredIntegrationToken[]> {
  return (await readIntegrationTokenFile(path)).tokens;
}

/**
 * Stamp `revokedAt` on a token. Revoked rows are kept rather than deleted so
 * the Settings list can say "revoked" instead of a token silently disappearing
 * from under a bot that is still presenting it. Returns false when no such id.
 */
export async function revokeIntegrationToken(
  path: string,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  return withIntegrationTokenLock(path, async () => {
    const data = await readIntegrationTokenFile(path);
    const row = data.tokens.find((t) => t.id === id);
    if (!row) return false;
    if (row.revokedAt === undefined) {
      row.revokedAt = now;
      await writeIntegrationTokenFile(path, data);
    }
    return true;
  });
}

/**
 * Parse the `--expires` spelling the CLI accepts: a duration (`30d`, `12h`,
 * `90m`) or an ISO date. Returns epoch ms.
 */
export function parseExpiry(value: string, now = Date.now()): number {
  const m = /^(\d+)([mhd])$/.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    return now + n * unit;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new CmError(`cannot read expiry "${value}" — use 30d, 12h, 90m or an ISO date`);
  return at;
}
