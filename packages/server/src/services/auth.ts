import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type {
  AuthSecurityOverview,
  AuthSessionResponse,
  AuthSessionSummary,
  AuthSetupCode,
  AuthStatus,
  AuthUserSummary,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { readJson, writeJsonAtomic } from "../store/fsq.js";

const ACCESS_SECONDS = 10 * 60;
const REFRESH_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const SETUP_MS = 15 * 60 * 1000;
const CONCURRENT_REFRESH_GRACE_MS = 2_000;
const AUTH_LOCK_WAIT_MS = 5_000;

export const REFRESH_COOKIE = "dispatch_refresh";

interface PasswordCredential { hash: string }
interface PasskeyCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  name: string;
  createdAt: number;
  lastUsedAt?: number;
}
interface TotpCredential { secret: string; enabledAt: number }
interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  owner: boolean;
  disabled: boolean;
  createdAt: number;
  password?: PasswordCredential;
  passkeys: PasskeyCredential[];
  totp?: TotpCredential;
  /** Provider links resolve to this stable user id; authorization never depends on provider shape. */
  externalIdentities?: Array<{ provider: string; subject: string; linkedAt: number }>;
  securityVersion?: number;
}
interface RefreshFamily {
  id: string;
  userId: string;
  securityVersion?: number;
  authEpoch?: number;
  currentHash: string;
  previousHash?: string;
  rotatedAt?: number;
  uaBinding: string;
  userAgent: string;
  ip?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
}
interface SetupCodeRow {
  id: string;
  hash: string;
  createdBy: string;
  expiresAt: number;
  usedAt?: number;
}
interface AuthData {
  version: 1;
  signingSecret: string;
  sessionEpoch?: number;
  users: StoredUser[];
  setupCodes: SetupCodeRow[];
}
interface AuthSessionData { version: 1; sessions: RefreshFamily[] }

function emptyAuthData(): AuthData {
  return { version: 1, signingSecret: b64url(randomBytes(32)), sessionEpoch: 0, users: [], setupCodes: [] };
}

async function processIsAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function withAuthFileLock<T>(authFile: string, task: () => Promise<T>): Promise<T> {
  const lockDir = `${authFile}.lock`;
  const ownerFile = join(lockDir, "owner.json");
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerFile, JSON.stringify({ pid: process.pid, nonce, acquiredAt: Date.now() }), { mode: 0o600 });
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
        try { stale = Date.now() - (await stat(lockDir)).mtimeMs > 1_000; } catch { continue; }
      }
      if (stale) {
        const quarantine = `${lockDir}.stale-${crypto.randomUUID()}`;
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
      if (Date.now() >= deadline) throw new AuthFailure(503, "Authentication data is busy. Try again shortly.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await task(); }
  finally {
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
        // A final failure leaves only this exact lock dir and owner metadata;
        // the bounded stale-owner path above recovers it after process death.
      }
    }
  }
}

interface Challenge {
  kind: "register" | "login";
  challenge: string;
  userId?: string;
  expiresAt: number;
}

export class AuthFailure extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RequestIdentity {
  user: AuthUserSummary;
  sessionId: string;
  securityVersion: number;
  authEpoch: number;
}

function b64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function normalizeUsername(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateWebAuthnConfig(input: { canonicalUrl: string; rpId?: string }): { canonicalUrl: string; rpId: string } {
  let canonical: URL;
  try { canonical = new URL(input.canonicalUrl); }
  catch { throw new AuthFailure(400, "Canonical URL is invalid."); }
  if (canonical.protocol !== "https:" && canonical.hostname !== "localhost" && canonical.hostname !== "127.0.0.1") {
    throw new AuthFailure(400, "Non-local passkey origins must use HTTPS.");
  }
  const rpId = (input.rpId?.trim() || canonical.hostname).toLowerCase();
  const host = canonical.hostname.toLowerCase();
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new AuthFailure(400, "The passkey RP ID must be the canonical hostname or its parent domain.");
  }
  return { canonicalUrl: canonical.origin, rpId };
}

/** Stable enough to catch token theft without revoking on patch-version churn. */
export function normalizeUserAgent(ua: string): string {
  const major = (pattern: RegExp, name: string): string | undefined => {
    const version = pattern.exec(ua)?.[1];
    return version ? `${name}/${version}` : undefined;
  };
  const browser =
    major(/Edg\/(\d+)/, "edge") ??
    major(/Firefox\/(\d+)/, "firefox") ??
    major(/(?:Chrome|CriOS)\/(\d+)/, "chrome") ??
    major(/Version\/(\d+).*Safari/, "safari") ??
    "other/0";
  const os = /Windows NT/.test(ua)
    ? "windows"
    : /Android/.test(ua)
      ? "android"
      : /(?:iPhone|iPad|iPod)/.test(ua)
        ? "ios"
        : /Mac OS X/.test(ua)
          ? "macos"
          : /Linux/.test(ua)
            ? "linux"
            : "other";
  const device = /Mobile|Android|iPhone|iPod/.test(ua)
    ? "mobile"
    : /iPad|Tablet/.test(ua)
      ? "tablet"
      : "desktop";
  return `${browser}|${os}|${device}`;
}

function userSummary(user: StoredUser): AuthUserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    owner: user.owner,
    disabled: user.disabled,
    createdAt: user.createdAt,
    hasPassword: !!user.password,
    passkeyCount: user.passkeys.length,
    totpEnabled: !!user.totp,
  };
}

function securityVersion(user: StoredUser): number {
  return user.securityVersion ?? 0;
}

function authEpoch(data: AuthData): number {
  return data.sessionEpoch ?? 0;
}

function sessionSummary(row: RefreshFamily, currentId?: string): AuthSessionSummary {
  return {
    id: row.id,
    current: row.id === currentId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    userAgent: row.userAgent,
    ip: row.ip,
  };
}

function parseBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of value.replace(/=+$/g, "").toUpperCase()) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error("invalid base32");
    bits += n.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function toBase32(value: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = [...value].map((n) => n.toString(2).padStart(8, "0")).join("");
  let out = "";
  while (bits.length) {
    out += alphabet[Number.parseInt(bits.slice(0, 5).padEnd(5, "0"), 2)];
    bits = bits.slice(5);
  }
  return out;
}

export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (let drift = -1; drift <= 1; drift++) {
    let counter = Math.floor(at / 30_000) + drift;
    const buf = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
    const hmac = createHmac("sha1", parseBase32(secret)).update(buf).digest();
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const value = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) |
      (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
    if (String(value % 1_000_000).padStart(6, "0") === code) return true;
  }
  return false;
}

export class AuthService {
  private data: AuthData | null = null;
  private sessionData: AuthSessionData | null = null;
  private loadPromise: Promise<AuthData> | null = null;
  private authStamp: string | null = null;
  private authReload: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  private challenges = new Map<string, Challenge>();
  private rates = new Map<string, number[]>();
  private revocationListeners = new Set<(sessionId: string) => void>();
  private settingsCache: { value: Awaited<ReturnType<Store["getSettings"]>>["auth"]; expiresAt: number } | null = null;
  private settingsLoad: Promise<Awaited<ReturnType<Store["getSettings"]>>["auth"]> | null = null;

  constructor(private store: Store) {}

  /** Serialize check-then-write credential/session mutations within this process. */
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); }
    finally { release(); }
  }

  private async sharedMutation<T>(task: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.load();
      return withAuthFileLock(this.store.authFile(), async () => {
        await this.reloadAuth(true);
        return task();
      });
    });
  }

  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }
  private notifyRevoked(sessionId: string): void {
    for (const listener of this.revocationListeners) listener(sessionId);
  }

  private async load(): Promise<AuthData> {
    if (!this.data) {
      if (!this.loadPromise) this.loadPromise = this.loadOnce();
      try { await this.loadPromise; }
      catch (error) { this.loadPromise = null; throw error; }
    }
    await this.reloadAuth(false);
    return this.data!;
  }

  private async loadOnce(): Promise<AuthData> {
    const [raw, rawSessions] = await Promise.all([
      readJson(this.store.authFile()) as Promise<AuthData | undefined>,
      readJson(this.store.authSessionsFile()) as Promise<AuthSessionData | undefined>,
    ]);
    this.data = raw?.version === 1 ? raw : emptyAuthData();
    this.sessionData = rawSessions?.version === 1 ? rawSessions : { version: 1, sessions: [] };
    this.authStamp = await this.readAuthStamp();
    // auth.json is created only by a shared mutation while holding its
    // cross-process lock. Session state is per-instance and needs no file lock.
    if (!rawSessions) await this.persistSessions();
    return this.data;
  }

  private async readAuthStamp(): Promise<string | null> {
    try {
      const info = await stat(this.store.authFile(), { bigint: true });
      return `${info.mtimeNs}:${info.size}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async reloadAuth(force: boolean): Promise<void> {
    if (this.authReload) {
      await this.authReload;
      if (force) return this.reloadAuth(true);
      return;
    }
    this.authReload = (async () => {
      const stamp = await this.readAuthStamp();
      if (!force && stamp === this.authStamp) return;
      const raw = await readJson(this.store.authFile()) as AuthData | undefined;
      this.data = raw?.version === 1 ? raw : emptyAuthData();
      this.authStamp = await this.readAuthStamp();
    })().finally(() => { this.authReload = null; });
    return this.authReload;
  }

  private async persist(): Promise<void> {
    await this.queuePersist(true, true);
  }

  private async persistAuth(): Promise<void> {
    await this.queuePersist(true, false);
  }

  private async persistSessions(): Promise<void> {
    await this.queuePersist(false, true);
  }

  private async queuePersist(auth: boolean, sessions: boolean): Promise<void> {
    const value = this.data;
    const sessionValue = this.sessionData;
    if (!value || !sessionValue) return;
    // A transient disk error must fail this operation without permanently
    // poisoning every later recovery write in the process.
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const writes: Promise<void>[] = [];
      if (auth) writes.push(writeJsonAtomic(this.store.authFile(), value, { mode: 0o600 }));
      if (sessions) writes.push(writeJsonAtomic(this.store.authSessionsFile(), sessionValue, { mode: 0o600 }));
      await Promise.all(writes);
      if (auth) this.authStamp = await this.readAuthStamp();
    });
    await this.writeChain;
  }

  private limit(key: string, max = 8, windowMs = 60_000): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    const hits = (this.rates.get(key) ?? []).filter((n) => n > now - windowMs);
    if (hits.length >= max) throw new AuthFailure(429, "Too many attempts. Try again shortly.");
    hits.push(now);
    this.rates.set(key, hits);
  }

  async settings(): Promise<Awaited<ReturnType<Store["getSettings"]>>["auth"]> {
    const now = Date.now();
    if (this.settingsCache && this.settingsCache.expiresAt > now) return this.settingsCache.value;
    if (!this.settingsLoad) {
      this.settingsLoad = this.store.getSettings().then((settings) => {
        this.settingsCache = { value: settings.auth, expiresAt: Date.now() + 1_000 };
        return settings.auth;
      }).finally(() => { this.settingsLoad = null; });
    }
    return this.settingsLoad;
  }

  private async saveAuthSettings(auth: NonNullable<Awaited<ReturnType<Store["getSettings"]>>["auth"]>): Promise<void> {
    const settings = await this.store.getSettings();
    await this.store.saveSettings({ ...settings, auth });
    this.settingsCache = { value: auth, expiresAt: Date.now() + 1_000 };
  }

  async enabled(): Promise<boolean> {
    return (await this.settings())?.enabled === true;
  }

  private sign(payload: Record<string, unknown>): string {
    if (!this.data) throw new Error("auth data not loaded");
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const signature = createHmac("sha256", Buffer.from(this.data.signingSecret, "base64url"))
      .update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${signature}`;
  }

  private verifyJwt(token: string, type: "access" | "ws"): Record<string, unknown> | null {
    if (!this.data) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = createHmac("sha256", Buffer.from(this.data.signingSecret, "base64url"))
      .update(`${parts[0]}.${parts[1]}`).digest("base64url");
    if (!safeEqual(expected, parts[2]!)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      if (payload.typ !== type || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch { return null; }
  }

  async authenticateAccess(token: string | undefined): Promise<RequestIdentity | null> {
    const data = await this.load();
    if (!token) return null;
    const payload = this.verifyJwt(token, "access");
    if (!payload || typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    const user = data.users.find((u) => u.id === payload.sub && !u.disabled);
    const family = this.sessionData!.sessions.find((s) => s.id === payload.sid && !s.revokedAt);
    const version = user ? securityVersion(user) : -1;
    const epoch = authEpoch(data);
    if (!user || !family || family.userId !== user.id || family.securityVersion !== version || payload.ver !== version ||
        family.authEpoch !== epoch || payload.aep !== epoch ||
        family.expiresAt <= Date.now() || family.absoluteExpiresAt <= Date.now()) return null;
    return { user: userSummary(user), sessionId: family.id, securityVersion: version, authEpoch: epoch };
  }

  async authenticateWs(ticket: string | undefined): Promise<RequestIdentity | null> {
    const data = await this.load();
    if (!ticket) return null;
    const payload = this.verifyJwt(ticket, "ws");
    if (!payload || typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    const user = data.users.find((u) => u.id === payload.sub && !u.disabled);
    const family = this.sessionData!.sessions.find((s) => s.id === payload.sid && !s.revokedAt);
    const now = Date.now();
    const version = user ? securityVersion(user) : -1;
    const epoch = authEpoch(data);
    return user && family && family.userId === user.id && family.securityVersion === version && payload.ver === version &&
        family.authEpoch === epoch && payload.aep === epoch &&
        family.expiresAt > now && family.absoluteExpiresAt > now
      ? { user: userSummary(user), sessionId: family.id, securityVersion: version, authEpoch: epoch }
      : null;
  }

  async identityStillValid(identity: RequestIdentity): Promise<boolean> {
    const data = await this.load();
    const user = data.users.find((row) => row.id === identity.user.id && !row.disabled);
    return !!user && securityVersion(user) === identity.securityVersion && authEpoch(data) === identity.authEpoch;
  }

  async status(token?: string): Promise<AuthStatus> {
    const data = await this.load();
    const settings = await this.settings();
    const identity = await this.authenticateAccess(token);
    return {
      enabled: settings?.enabled === true,
      configured: data.users.length > 0,
      firstRunDismissed: settings?.firstRunDismissed === true || (!settings && !this.store.isFreshInstall()),
      canonicalUrl: settings?.canonicalUrl,
      rpId: settings?.rpId,
      user: identity?.user ?? null,
    };
  }

  async dismissFirstRun(): Promise<void> {
    const settings = await this.store.getSettings();
    await this.saveAuthSettings({ ...settings.auth, enabled: false, firstRunDismissed: true });
  }

  async bootstrap(input: { username: string; displayName?: string; password: string; canonicalUrl: string; rpId?: string }, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    return this.sharedMutation(() => this.bootstrapUnsafe(input, meta));
  }

  private async bootstrapUnsafe(input: { username: string; displayName?: string; password: string; canonicalUrl: string; rpId?: string }, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    const data = await this.load();
    this.limit(`bootstrap:${meta.ip ?? "local"}`, 5, 5 * 60_000);
    if (data.users.length) throw new AuthFailure(409, "Authentication is already configured.");
    this.validatePassword(input.password);
    const webauthn = validateWebAuthnConfig(input);
    const user: StoredUser = {
      id: crypto.randomUUID(), username: normalizeUsername(input.username),
      displayName: input.displayName?.trim() || input.username.trim(), owner: true,
      disabled: false, createdAt: Date.now(), passkeys: [], externalIdentities: [], securityVersion: 1,
      password: { hash: await this.hashPassword(input.password) },
    };
    if (!user.username) throw new AuthFailure(400, "Username is required.");
    data.users.push(user);
    // Persist the recoverable owner before flipping the gate on. A crash between
    // these writes leaves auth safely disabled and re-enableable from Settings,
    // never enabled with no account capable of logging in.
    await this.persistAuth();
    await this.saveAuthSettings({
      enabled: true, firstRunDismissed: true,
      canonicalUrl: webauthn.canonicalUrl,
      rpId: webauthn.rpId,
    });
    return this.issueSession(user, meta);
  }

  private validatePassword(password: string): void {
    if (password.length < 12 || password.length > 256) throw new AuthFailure(400, "Password must be 12–256 characters.");
  }
  private hashPassword(password: string): Promise<string> {
    // 2 is Argon2id. The package exposes it as an ambient const enum, which
    // cannot be imported under this repo's verbatimModuleSyntax setting.
    return argonHash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 3, parallelism: 1 });
  }

  private async bumpSecurity(user: StoredUser, currentSessionId?: string): Promise<void> {
    user.securityVersion = securityVersion(user) + 1;
    if (currentSessionId) {
      const current = this.sessionData!.sessions.find((row) => row.id === currentSessionId && !row.revokedAt);
      if (current) {
        current.securityVersion = user.securityVersion;
        await this.persistSessions();
      }
    }
  }

  async login(input: { username: string; password: string; totp?: string }, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    return this.exclusive(() => this.loginUnsafe(input, meta));
  }

  private async loginUnsafe(input: { username: string; password: string; totp?: string }, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    const data = await this.load();
    this.limit(`login:${meta.ip ?? "local"}`);
    const username = normalizeUsername(input.username);
    this.limit(`login-user:${digest(username)}`);
    const user = data.users.find((u) => u.username === username && !u.disabled);
    // Always execute Argon2, so timing does not reveal whether an account exists.
    const fallback = "$argon2id$v=19$m=19456,t=3,p=1$ZGlzcGF0Y2gtZmFsbGJhY2s$4MCOGNkPQFwxrvDZjGuJTfRhXMAd5lZld0T4V0PC4tI";
    let valid = false;
    try { valid = await argonVerify(user?.password?.hash ?? fallback, input.password); } catch { valid = false; }
    if (!user || !valid || (user.totp && !verifyTotp(user.totp.secret, input.totp ?? ""))) {
      throw new AuthFailure(401, "Invalid username or credentials.");
    }
    return this.issueSession(user, meta);
  }

  private async issueSession(user: StoredUser, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    const data = await this.load();
    const now = Date.now();
    const id = crypto.randomUUID();
    const secret = b64url(randomBytes(32));
    const raw = `${id}.${secret}`;
    const version = securityVersion(user);
    const epoch = authEpoch(data);
    this.sessionData!.sessions.push({ id, userId: user.id, securityVersion: version, authEpoch: epoch, currentHash: digest(raw),
      uaBinding: normalizeUserAgent(meta.ua), userAgent: meta.ua.slice(0, 300), ip: meta.ip,
      createdAt: now, lastUsedAt: now, expiresAt: now + REFRESH_SLIDING_MS,
      absoluteExpiresAt: now + REFRESH_ABSOLUTE_MS });
    await this.persistSessions();
    const nowSec = Math.floor(now / 1000);
    return { refreshToken: raw, session: {
      accessToken: this.sign({ sub: user.id, sid: id, ver: version, aep: epoch, typ: "access", iat: nowSec, exp: nowSec + ACCESS_SECONDS }),
      expiresIn: ACCESS_SECONDS, user: userSummary(user),
    }};
  }

  async refresh(raw: string | undefined, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    return this.exclusive(() => this.refreshUnsafe(raw, meta));
  }

  private async refreshUnsafe(raw: string | undefined, meta: { ua: string; ip?: string }): Promise<{ session: AuthSessionResponse; refreshToken: string }> {
    const data = await this.load();
    this.limit(`refresh:${meta.ip ?? "local"}`, 30);
    const id = raw?.split(".", 1)[0];
    const family = this.sessionData!.sessions.find((s) => s.id === id);
    const now = Date.now();
    if (!raw || !family || family.revokedAt || family.expiresAt <= now || family.absoluteExpiresAt <= now) {
      throw new AuthFailure(401, "Session expired.");
    }
    const incoming = digest(raw);
    if (family.previousHash && safeEqual(incoming, family.previousHash)) {
      if (family.rotatedAt && now - family.rotatedAt <= CONCURRENT_REFRESH_GRACE_MS &&
          family.uaBinding === normalizeUserAgent(meta.ua) && family.ip === meta.ip) {
        throw new AuthFailure(409, "Session refreshed concurrently. Retry with the current cookie.");
      }
      family.revokedAt = now;
      await this.persistSessions();
      this.notifyRevoked(family.id);
      throw new AuthFailure(401, "Session revoked.");
    }
    if (!safeEqual(incoming, family.currentHash)) {
      // The family id is itself unguessable and only leaves the server inside a
      // refresh token. Any non-current secret for that family is therefore a
      // replay (including tokens older than the immediately previous one).
      family.revokedAt = now;
      await this.persistSessions();
      this.notifyRevoked(family.id);
      throw new AuthFailure(401, "Session revoked.");
    }
    if (family.uaBinding !== normalizeUserAgent(meta.ua)) {
      family.revokedAt = now;
      await this.persistSessions();
      this.notifyRevoked(family.id);
      throw new AuthFailure(401, "Session revoked.");
    }
    const user = data.users.find((u) => u.id === family.userId && !u.disabled);
    if (!user) throw new AuthFailure(401, "Session expired.");
    const version = securityVersion(user);
    const epoch = authEpoch(data);
    if (family.securityVersion !== version || family.authEpoch !== epoch) {
      family.revokedAt = now;
      await this.persistSessions();
      this.notifyRevoked(family.id);
      throw new AuthFailure(401, "Session revoked.");
    }
    const next = `${family.id}.${b64url(randomBytes(32))}`;
    family.previousHash = family.currentHash;
    family.currentHash = digest(next);
    family.rotatedAt = now;
    family.lastUsedAt = now;
    family.expiresAt = Math.min(now + REFRESH_SLIDING_MS, family.absoluteExpiresAt);
    await this.persistSessions();
    const nowSec = Math.floor(now / 1000);
    return { refreshToken: next, session: {
      accessToken: this.sign({ sub: user.id, sid: family.id, ver: version, aep: epoch, typ: "access", iat: nowSec, exp: nowSec + ACCESS_SECONDS }),
      expiresIn: ACCESS_SECONDS, user: userSummary(user),
    }};
  }

  async wsTicket(identity: RequestIdentity): Promise<string> {
    await this.load();
    const now = Math.floor(Date.now() / 1000);
    return this.sign({ sub: identity.user.id, sid: identity.sessionId, ver: identity.securityVersion,
      aep: identity.authEpoch, typ: "ws", iat: now, exp: now + 30 });
  }

  async logout(sessionId: string): Promise<void> {
    return this.exclusive(() => this.logoutUnsafe(sessionId));
  }

  private async logoutUnsafe(sessionId: string): Promise<void> {
    await this.load();
    const row = this.sessionData!.sessions.find((s) => s.id === sessionId);
    if (row) { row.revokedAt = Date.now(); await this.persistSessions(); this.notifyRevoked(row.id); }
  }

  async disable(identity: RequestIdentity): Promise<void> {
    return this.sharedMutation(() => this.disableUnsafe(identity));
  }

  private async disableUnsafe(identity: RequestIdentity): Promise<void> {
    if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
    const data = await this.load();
    const now = Date.now();
    for (const row of this.sessionData!.sessions) if (!row.revokedAt) {
      row.revokedAt = now;
      this.notifyRevoked(row.id);
    }
    // Revoke first: a crash can leave auth enabled, but can never leave tokens
    // live after Settings says it was disabled and those credentials are re-used.
    await this.persistSessions();
    data.sessionEpoch = authEpoch(data) + 1;
    await this.persistAuth();
    const settings = await this.store.getSettings();
    await this.saveAuthSettings({ ...settings.auth, enabled: false, firstRunDismissed: true });
  }

  async enableWithPassword(input: { username: string; password: string; totp?: string }, meta: { ua: string; ip?: string }) {
    return this.exclusive(() => this.enableWithPasswordUnsafe(input, meta));
  }

  private async enableWithPasswordUnsafe(input: { username: string; password: string; totp?: string }, meta: { ua: string; ip?: string }) {
    if ((await this.enabled())) throw new AuthFailure(409, "Authentication is already enabled.");
    const result = await this.loginUnsafe(input, meta);
    const settings = await this.store.getSettings();
    await this.saveAuthSettings({ ...settings.auth, enabled: true, firstRunDismissed: true });
    return result;
  }

  async security(identity: RequestIdentity): Promise<AuthSecurityOverview> {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    return { user: userSummary(user),
      sessions: this.sessionData!.sessions.filter((s) => s.userId === user.id && !s.revokedAt && s.absoluteExpiresAt > Date.now()).map((s) => sessionSummary(s, identity.sessionId)),
      passkeys: user.passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
    };
  }

  async listUsers(identity: RequestIdentity): Promise<AuthUserSummary[]> {
    if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
    return (await this.load()).users.map(userSummary);
  }

  async updateWebAuthnSettings(identity: RequestIdentity, input: { canonicalUrl: string; rpId?: string }): Promise<{ canonicalUrl: string; rpId: string }> {
    return this.sharedMutation(async () => {
      if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
      const webauthn = validateWebAuthnConfig(input);
      const settings = await this.store.getSettings();
      await this.saveAuthSettings({ ...settings.auth, ...webauthn, enabled: true, firstRunDismissed: true });
      return webauthn;
    });
  }

  async createSetupCode(identity: RequestIdentity): Promise<AuthSetupCode> {
    return this.sharedMutation(() => this.createSetupCodeUnsafe(identity));
  }

  private async createSetupCodeUnsafe(identity: RequestIdentity): Promise<AuthSetupCode> {
    if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
    const data = await this.load();
    const code = b64url(randomBytes(18));
    const row = { id: crypto.randomUUID(), hash: digest(code), createdBy: identity.user.id, expiresAt: Date.now() + SETUP_MS };
    data.setupCodes.push(row);
    await this.persistAuth();
    const canonicalUrl = (await this.settings())?.canonicalUrl;
    if (!canonicalUrl) throw new AuthFailure(400, "Configure a canonical URL before inviting accounts.");
    return { code, url: `${canonicalUrl}/?setup=${encodeURIComponent(code)}`, expiresAt: row.expiresAt };
  }

  async redeemSetupCode(input: { code: string; username: string; displayName?: string; password: string }, meta: { ua: string; ip?: string }) {
    return this.sharedMutation(() => this.redeemSetupCodeUnsafe(input, meta));
  }

  private async redeemSetupCodeUnsafe(input: { code: string; username: string; displayName?: string; password: string }, meta: { ua: string; ip?: string }) {
    const data = await this.load();
    this.limit(`setup:${meta.ip ?? "local"}`, 8, 5 * 60_000);
    const row = data.setupCodes.find((s) => !s.usedAt && s.expiresAt > Date.now() && safeEqual(s.hash, digest(input.code)));
    if (!row) throw new AuthFailure(400, "Setup link is invalid or expired.");
    this.validatePassword(input.password);
    const username = normalizeUsername(input.username);
    if (!username || data.users.some((u) => u.username === username)) throw new AuthFailure(400, "Unable to create account.");
    const user: StoredUser = { id: crypto.randomUUID(), username,
      displayName: input.displayName?.trim() || input.username.trim(), owner: false,
      disabled: false, createdAt: Date.now(), passkeys: [], externalIdentities: [], securityVersion: 1,
      password: { hash: await this.hashPassword(input.password) } };
    row.usedAt = Date.now();
    data.users.push(user);
    await this.persistAuth();
    return this.issueSession(user, meta);
  }

  async updatePassword(identity: RequestIdentity, input: { currentPassword: string; password: string }): Promise<void> {
    return this.sharedMutation(() => this.updatePasswordUnsafe(identity, input));
  }

  private async updatePasswordUnsafe(identity: RequestIdentity, input: { currentPassword: string; password: string }): Promise<void> {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    if (!user.password || !(await argonVerify(user.password.hash, input.currentPassword))) throw new AuthFailure(401, "Current password is incorrect.");
    this.validatePassword(input.password);
    user.password = { hash: await this.hashPassword(input.password) };
    await this.bumpSecurity(user, identity.sessionId);
    await this.persistAuth();
  }

  async beginTotp(identity: RequestIdentity): Promise<{ secret: string; uri: string }> {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    const secret = toBase32(randomBytes(20));
    this.challenges.set(`totp:${user.id}`, { kind: "register", challenge: secret, userId: user.id, expiresAt: Date.now() + CHALLENGE_MS });
    return { secret, uri: `otpauth://totp/Dispatch:${encodeURIComponent(user.username)}?secret=${secret}&issuer=Dispatch` };
  }

  async confirmTotp(identity: RequestIdentity, code: string): Promise<void> {
    return this.sharedMutation(() => this.confirmTotpUnsafe(identity, code));
  }

  private async confirmTotpUnsafe(identity: RequestIdentity, code: string): Promise<void> {
    const data = await this.load();
    const challenge = this.challenges.get(`totp:${identity.user.id}`);
    if (!challenge || challenge.expiresAt < Date.now() || !verifyTotp(challenge.challenge, code)) throw new AuthFailure(400, "Invalid verification code.");
    const user = data.users.find((u) => u.id === identity.user.id)!;
    user.totp = { secret: challenge.challenge, enabledAt: Date.now() };
    this.challenges.delete(`totp:${identity.user.id}`);
    await this.bumpSecurity(user, identity.sessionId);
    await this.persistAuth();
  }

  async disableTotp(identity: RequestIdentity, password: string): Promise<void> {
    return this.sharedMutation(() => this.disableTotpUnsafe(identity, password));
  }

  private async disableTotpUnsafe(identity: RequestIdentity, password: string): Promise<void> {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    if (!user.password || !(await argonVerify(user.password.hash, password))) throw new AuthFailure(401, "Password is incorrect.");
    delete user.totp;
    await this.bumpSecurity(user, identity.sessionId);
    await this.persistAuth();
  }

  async registrationOptions(identity: RequestIdentity) {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    const settings = await this.settings();
    if (!settings?.rpId || !settings.canonicalUrl) throw new AuthFailure(400, "Configure a canonical URL before adding passkeys.");
    const options = await generateRegistrationOptions({ rpName: "Dispatch", rpID: settings.rpId,
      userName: user.username, userDisplayName: user.displayName, userID: Buffer.from(user.id),
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: user.passkeys.map((p) => ({ id: p.id, transports: p.transports })) });
    this.challenges.set(`reg:${user.id}`, { kind: "register", challenge: options.challenge, userId: user.id, expiresAt: Date.now() + CHALLENGE_MS });
    return options;
  }

  async verifyRegistration(identity: RequestIdentity, response: RegistrationResponseJSON, name?: string): Promise<void> {
    return this.sharedMutation(() => this.verifyRegistrationUnsafe(identity, response, name));
  }

  private async verifyRegistrationUnsafe(identity: RequestIdentity, response: RegistrationResponseJSON, name?: string): Promise<void> {
    const data = await this.load();
    const settings = await this.settings();
    const challenge = this.challenges.get(`reg:${identity.user.id}`);
    if (!settings?.rpId || !settings.canonicalUrl || !challenge || challenge.expiresAt < Date.now()) throw new AuthFailure(400, "Passkey challenge expired.");
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: settings.canonicalUrl, expectedRPID: settings.rpId, requireUserVerification: true });
    if (!verified.verified) throw new AuthFailure(400, "Passkey verification failed.");
    const user = data.users.find((u) => u.id === identity.user.id)!;
    const cred = verified.registrationInfo.credential;
    if (!user.passkeys.some((p) => p.id === cred.id)) user.passkeys.push({ id: cred.id,
      publicKey: b64url(cred.publicKey), counter: cred.counter, transports: response.response.transports,
      name: name?.trim() || "Passkey", createdAt: Date.now() });
    this.challenges.delete(`reg:${identity.user.id}`);
    await this.bumpSecurity(user, identity.sessionId);
    await this.persistAuth();
  }

  async authenticationOptions(meta?: { ip?: string }) {
    await this.load();
    this.limit(`passkey-options:${meta?.ip ?? "local"}`, 20);
    const settings = await this.settings();
    if (!settings?.rpId) throw new AuthFailure(400, "Passkeys are not configured.");
    const options = await generateAuthenticationOptions({ rpID: settings.rpId, userVerification: "required" });
    const id = b64url(randomBytes(18));
    this.challenges.set(`login:${id}`, { kind: "login", challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_MS });
    return { id, options };
  }

  async verifyAuthentication(input: { id: string; response: AuthenticationResponseJSON }, meta: { ua: string; ip?: string }) {
    return this.sharedMutation(() => this.verifyAuthenticationUnsafe(input, meta));
  }

  private async verifyAuthenticationUnsafe(input: { id: string; response: AuthenticationResponseJSON }, meta: { ua: string; ip?: string }) {
    const data = await this.load();
    this.limit(`passkey:${meta.ip ?? "local"}`);
    const settings = await this.settings();
    const challenge = this.challenges.get(`login:${input.id}`);
    const user = data.users.find((u) => u.passkeys.some((p) => p.id === input.response.id) && !u.disabled);
    const passkey = user?.passkeys.find((p) => p.id === input.response.id);
    if (!settings?.rpId || !settings.canonicalUrl || !challenge || challenge.expiresAt < Date.now() || !user || !passkey) throw new AuthFailure(401, "Unable to sign in with this passkey.");
    const verified = await verifyAuthenticationResponse({ response: input.response,
      expectedChallenge: challenge.challenge, expectedOrigin: settings.canonicalUrl, expectedRPID: settings.rpId,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true });
    if (!verified.verified) throw new AuthFailure(401, "Unable to sign in with this passkey.");
    passkey.counter = verified.authenticationInfo.newCounter;
    passkey.lastUsedAt = Date.now();
    this.challenges.delete(`login:${input.id}`);
    await this.persistAuth();
    return this.issueSession(user, meta);
  }

  async removePasskey(identity: RequestIdentity, passkeyId: string): Promise<void> {
    return this.sharedMutation(() => this.removePasskeyUnsafe(identity, passkeyId));
  }

  private async removePasskeyUnsafe(identity: RequestIdentity, passkeyId: string): Promise<void> {
    const data = await this.load();
    const user = data.users.find((u) => u.id === identity.user.id)!;
    if (user.passkeys.length <= 1 && !user.password) throw new AuthFailure(400, "Add another login method before removing this passkey.");
    user.passkeys = user.passkeys.filter((p) => p.id !== passkeyId);
    await this.bumpSecurity(user, identity.sessionId);
    await this.persistAuth();
  }

  async revokeSession(identity: RequestIdentity, id: string): Promise<void> {
    return this.exclusive(() => this.revokeSessionUnsafe(identity, id));
  }

  private async revokeSessionUnsafe(identity: RequestIdentity, id: string): Promise<void> {
    await this.load();
    const row = this.sessionData!.sessions.find((s) => s.id === id && s.userId === identity.user.id);
    if (!row) throw new AuthFailure(404, "Session not found.");
    row.revokedAt = Date.now();
    await this.persistSessions();
    this.notifyRevoked(row.id);
  }

  async ownerResetUser(identity: RequestIdentity, userId: string, password: string): Promise<void> {
    return this.sharedMutation(() => this.ownerResetUserUnsafe(identity, userId, password));
  }

  private async ownerResetUserUnsafe(identity: RequestIdentity, userId: string, password: string): Promise<void> {
    if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
    this.validatePassword(password);
    const data = await this.load();
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new AuthFailure(404, "Account not found.");
    const hash = await this.hashPassword(password);
    for (const row of this.sessionData!.sessions) if (row.userId === userId) {
      row.revokedAt = Date.now(); this.notifyRevoked(row.id);
    }
    await this.persistSessions();
    user.password = { hash };
    delete user.totp;
    user.securityVersion = securityVersion(user) + 1;
    await this.persistAuth();
  }

  async ownerDeleteUser(identity: RequestIdentity, userId: string): Promise<void> {
    return this.sharedMutation(() => this.ownerDeleteUserUnsafe(identity, userId));
  }

  private async ownerDeleteUserUnsafe(identity: RequestIdentity, userId: string): Promise<void> {
    if (!identity.user.owner) throw new AuthFailure(403, "Owner access required.");
    const data = await this.load();
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new AuthFailure(404, "Account not found.");
    if (user.owner) throw new AuthFailure(400, "The bootstrap owner cannot be deleted.");
    for (const row of this.sessionData!.sessions) if (row.userId === userId) this.notifyRevoked(row.id);
    this.sessionData!.sessions = this.sessionData!.sessions.filter((s) => s.userId !== userId);
    await this.persistSessions();
    data.users = data.users.filter((u) => u.id !== userId);
    await this.persistAuth();
  }

  /** Local CLI recovery path; never exposed over HTTP. */
  async localResetOwner(password: string): Promise<string> {
    return this.sharedMutation(() => this.localResetOwnerUnsafe(password));
  }

  private async localResetOwnerUnsafe(password: string): Promise<string> {
    this.validatePassword(password);
    const data = await this.load();
    const owner = data.users.find((u) => u.owner);
    if (!owner) throw new AuthFailure(404, "No owner account exists.");
    const hash = await this.hashPassword(password);
    for (const row of this.sessionData!.sessions) {
      row.revokedAt = Date.now(); this.notifyRevoked(row.id);
    }
    await this.persistSessions();
    owner.password = { hash };
    delete owner.totp;
    owner.securityVersion = securityVersion(owner) + 1;
    await this.persistAuth();
    return owner.username;
  }
}
