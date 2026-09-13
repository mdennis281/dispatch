/**
 * The secret store — app-wide and per-project credentials that config refers to
 * as `${secret:NAME}` and no agent can read back.
 *
 * WHERE. `<config>/secrets.json`, beside `reviewer.json` and `auth.json`, so the
 * stable and dev instances see the same secrets (they share `config/`, never
 * `data/`). A project-scoped secret is keyed by project id rather than written
 * into the repo's `.dispatch/`, because that directory is COMMITTED.
 *
 * AT REST. Each value is AES-256-GCM encrypted under one data key in
 * `<config>/secrets.key`. On Windows that key is itself wrapped with DPAPI
 * (CurrentUser), so the two files copied off the machine — into a backup, a
 * support zip, a synced folder — decrypt to nothing. Without DPAPI the key is a
 * mode-0600 file, and the encryption is honest about what it is: it stops a
 * casual `cat secrets.json` from printing credentials, not the same user.
 *
 * TWO PROCESSES. Both instances read and write the one file. Every mutation is
 * a read-modify-write of the CURRENT file (not the cached copy), and every read
 * path re-checks the file's mtime first, so a secret saved in one instance is
 * seen by the other on its next access rather than being overwritten by it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  expandSecretsOnly,
  type McpServerConfig,
  SECRET_SCOPES,
  SecretNameSchema,
  type SecretScope,
  type SecretSummary,
} from "@dispatch/shared";
import { KeyedMutex, readJson, writeJsonAtomic } from "../store/fsq.js";

const EntrySchema = z.object({
  name: SecretNameSchema,
  scope: z.enum(SECRET_SCOPES),
  projectId: z.string().optional(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
  updatedAt: z.number(),
});
type Entry = z.infer<typeof EntrySchema>;

const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) });

const KeyFileSchema = z.object({
  version: z.literal(1),
  protection: z.enum(["dpapi", "none"]),
  key: z.string(),
});

/**
 * Wraps/unwraps the data key. Injected so tests don't spawn PowerShell, and so
 * a platform without DPAPI is one implementation rather than a branch in every
 * read.
 */
export interface KeyProtector {
  readonly kind: "dpapi" | "none";
  protect(key: Buffer): Promise<string>;
  unprotect(stored: string): Promise<Buffer>;
}

export const plainKeyProtector: KeyProtector = {
  kind: "none",
  protect: async (key) => key.toString("base64"),
  unprotect: async (stored) => Buffer.from(stored, "base64"),
};

/**
 * DPAPI through Windows PowerShell 5.1 — always present on Windows, and the key
 * travels on STDIN, never argv, because a command line is readable by every
 * process on the box for as long as the child lives.
 */
export const dpapiKeyProtector: KeyProtector = {
  kind: "dpapi",
  protect: (key) => runDpapi("Protect", key.toString("base64")),
  unprotect: async (stored) => Buffer.from(await runDpapi("Unprotect", stored), "base64"),
};

function runDpapi(op: "Protect" | "Unprotect", inputB64: string): Promise<string> {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$in=[Console]::In.ReadToEnd().Trim();" +
    `$out=[Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($in),$null,'CurrentUser');` +
    "[Console]::Out.Write([Convert]::ToBase64String($out))";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`DPAPI ${op} failed (exit ${code}): ${err.trim() || "no output"}`));
    });
    child.stdin.end(inputB64);
  });
}

export interface SecretsServiceOptions {
  configDir: string;
  /** Defaults to DPAPI on Windows, plain elsewhere. */
  protector?: KeyProtector;
}

export interface SecretKey {
  name: string;
  scope: SecretScope;
  projectId?: string;
}

/**
 * Listener for a change made by ANOTHER process sharing the config dir, noticed
 * on disk. A change made through this instance's own `set`/`delete` is not
 * announced here — its caller refreshes consumers itself and wants the report.
 */
export type SecretsChangeListener = (changed: SecretKey[]) => void | Promise<void>;

export class SecretsService {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly protector: KeyProtector;
  private readonly mutex = new KeyedMutex();
  private key: Buffer | null = null;
  /** `scope|projectId|name` → decrypted value. */
  private values = new Map<string, string>();
  private entries: Entry[] = [];
  private mtimeMs = -1;
  /** False until the first sync — that one is a load, not a change to announce. */
  private loaded = false;
  private watching = false;
  private listeners = new Set<SecretsChangeListener>();

  constructor(opts: SecretsServiceOptions) {
    this.file = join(opts.configDir, "secrets.json");
    this.keyFile = join(opts.configDir, "secrets.key");
    this.protector =
      opts.protector ?? (process.platform === "win32" ? dpapiKeyProtector : plainKeyProtector);
  }

  /**
   * Load what's on disk, then keep watching it. Never throws — an unreadable
   * store is an empty one, loudly.
   *
   * The watch is what lets the OTHER instance's save reach this one's consumers.
   * `resolve()` is synchronous and reads only the cache, so without it a key
   * saved from the dev instance would stay stale here until something happened
   * to list secrets. `watchFile` (stat polling) rather than `fs.watch`, because
   * the file is replaced by rename on every write and a rename is exactly what
   * `fs.watch` loses track of on Windows.
   */
  async start(opts: { watch?: boolean } = {}): Promise<void> {
    await this.sync().catch((err) => {
      console.warn(`[Dispatch] secrets could not be loaded: ${err instanceof Error ? err.message : err}`);
    });
    if (opts.watch) {
      watchFile(this.file, { interval: 2_000, persistent: false }, () => {
        void this.mutex.run("secrets", () => this.sync()).catch(() => {});
      });
      this.watching = true;
    }
  }

  stop(): void {
    if (this.watching) unwatchFile(this.file);
    this.watching = false;
  }

  onExternalChange(listener: SecretsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The value `${secret:NAME}` expands to for a project — the project's own
   * secret first, then the global one. SYNC on purpose: it is called while a
   * session's options are assembled, so it reads the cache `sync()` maintains.
   */
  resolve(projectId: string | undefined, name: string): string | undefined {
    if (projectId) {
      const own = this.values.get(slot({ name, scope: "project", projectId }));
      if (own !== undefined) return own;
    }
    return this.values.get(slot({ name, scope: "global" }));
  }

  /** A resolver bound to one project, in the shape `expandEnvVars` takes. */
  resolverFor(projectId: string | undefined): (name: string) => string | undefined {
    return (name) => this.resolve(projectId, name);
  }

  /** Names only. `projectId` narrows to global + that project's; omitted lists everything. */
  async list(projectId?: string): Promise<SecretSummary[]> {
    // Under the mutex like every other sync: two unserialized syncs racing the
    // watcher would both see the other instance's change and refresh it twice.
    await this.mutex.run("secrets", () => this.sync());
    return this.entries
      .filter((e) => projectId === undefined || e.scope === "global" || e.projectId === projectId)
      .map(({ name, scope, projectId: pid, updatedAt }) => ({
        name,
        scope,
        ...(pid ? { projectId: pid } : {}),
        updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  }

  async get(key: SecretKey): Promise<SecretSummary | null> {
    const all = await this.list();
    return all.find((s) => sameKey(s, key)) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<SecretSummary> {
    const k = normalize(key);
    const summary = await this.mutex.run("secrets", async () => {
      await this.sync();
      const dataKey = await this.dataKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      // The entry's identity is bound into the tag, so a ciphertext copied onto a
      // different name or project fails to decrypt instead of silently answering
      // for a secret it was never saved as.
      cipher.setAAD(Buffer.from(slot(k), "utf8"));
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const entry: Entry = {
        ...k,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
        // Strictly after any previous save, so a card that raced a same-millisecond
        // write can still tell its own save happened.
        updatedAt: Math.max(Date.now(), (this.entries.find((e) => sameKey(e, k))?.updatedAt ?? 0) + 1),
      };
      await this.write([...this.entries.filter((e) => !sameKey(e, k)), entry]);
      this.values.set(slot(k), value);
      return { name: k.name, scope: k.scope, ...(k.projectId ? { projectId: k.projectId } : {}), updatedAt: entry.updatedAt };
    });
    return summary;
  }

  /** True when something was deleted. */
  async delete(key: SecretKey): Promise<boolean> {
    const k = normalize(key);
    const removed = await this.mutex.run("secrets", async () => {
      await this.sync();
      const next = this.entries.filter((e) => !sameKey(e, k));
      if (next.length === this.entries.length) return false;
      await this.write(next);
      this.values.delete(slot(k));
      return true;
    });
    return removed;
  }

  /* ------------------------------------------------------------ internals */

  private async write(entries: Entry[]): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, entries }, { mode: 0o600 });
    this.entries = entries;
    this.mtimeMs = (await stat(this.file).catch(() => null))?.mtimeMs ?? -1;
  }

  /**
   * Re-read the file when it changed under us (the other instance saved), and
   * tell listeners which secrets moved so their consumers refresh too.
   */
  private async sync(): Promise<void> {
    const st = await stat(this.file).catch(() => null);
    const mtime = st?.mtimeMs ?? -1;
    if (this.loaded && mtime === this.mtimeMs) return;
    const raw = st ? await readJson(this.file) : undefined;
    const parsed = raw === undefined ? { version: 1 as const, entries: [] } : FileSchema.safeParse(raw).data;
    if (!parsed) throw new Error(`${this.file} is not a valid secrets file`);
    const first = !this.loaded;
    const before = new Map(this.entries.map((e) => [slot(e), e.updatedAt]));
    const values = new Map<string, string>();
    if (parsed.entries.length) {
      const dataKey = await this.dataKey();
      for (const e of parsed.entries) {
        try {
          values.set(slot(e), decrypt(dataKey, e));
        } catch {
          console.warn(`[Dispatch] secret ${e.name} (${e.scope}) could not be decrypted and is ignored.`);
        }
      }
    }
    this.entries = parsed.entries;
    this.values = values;
    this.mtimeMs = mtime;
    this.loaded = true;
    if (first) return;
    const changed: SecretKey[] = [];
    const after = new Map(parsed.entries.map((e) => [slot(e), e]));
    for (const e of parsed.entries) if (before.get(slot(e)) !== e.updatedAt) changed.push(keyOf(e));
    for (const s of before.keys()) if (!after.has(s)) changed.push(parseSlot(s));
    if (changed.length) void this.emit(changed);
  }

  private async dataKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const raw = await readJson(this.keyFile);
    if (raw !== undefined) {
      const kf = KeyFileSchema.parse(raw);
      const protector = kf.protection === "dpapi" ? dpapiKeyProtector : plainKeyProtector;
      // Tests inject a protector; honour it for the kind it claims to be.
      const use = this.protector.kind === kf.protection ? this.protector : protector;
      this.key = await use.unprotect(kf.key);
      return this.key;
    }
    const fresh = randomBytes(32);
    let protection: KeyProtector = this.protector;
    let stored: string;
    try {
      stored = await protection.protect(fresh);
    } catch (err) {
      console.warn(
        `[Dispatch] could not protect the secrets key with ${protection.kind} ` +
          `(${err instanceof Error ? err.message : err}); storing it as a 0600 file instead.`,
      );
      protection = plainKeyProtector;
      stored = await protection.protect(fresh);
    }
    await writeJsonAtomic(
      this.keyFile,
      { version: 1, protection: protection.kind, key: stored },
      { mode: 0o600 },
    );
    this.key = fresh;
    return fresh;
  }

  private async emit(changed: SecretKey[]): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(changed);
      } catch (err) {
        console.warn(`[Dispatch] secret change listener failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

/**
 * Fill `${secret:NAME}` into MCP server definitions — ONLY at the moment they
 * are handed to something that runs them (a session, a live swap, a prewarm, a
 * catalog probe). Everything upstream of that keeps the placeholder, because
 * upstream is persisted to `state.db` and pushed to browsers.
 */
export function expandSecretsInMcpServers(
  servers: Record<string, McpServerConfig>,
  lookup: ((name: string) => string | undefined) | undefined,
): Record<string, McpServerConfig> {
  if (!lookup) return servers;
  const str = (v: string | undefined) => (v === undefined ? undefined : expandSecretsOnly(v, lookup));
  const rec = (r: Record<string, string> | undefined) =>
    r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expandSecretsOnly(v, lookup)])) : r;
  return Object.fromEntries(
    Object.entries(servers).map(([name, cfg]) => {
      const c = cfg as McpServerConfig & Record<string, unknown>;
      const out: Record<string, unknown> = { ...c };
      if (typeof c.command === "string") out.command = str(c.command);
      if (Array.isArray(c.args)) out.args = (c.args as string[]).map((a) => expandSecretsOnly(a, lookup));
      if (c.env) out.env = rec(c.env as Record<string, string>);
      if (c.headers) out.headers = rec(c.headers as Record<string, string>);
      if (typeof c.url === "string") out.url = str(c.url);
      if (typeof c.cwd === "string") out.cwd = str(c.cwd);
      if (typeof c.prewarm === "string") out.prewarm = str(c.prewarm);
      return [name, out as McpServerConfig];
    }),
  );
}

function normalize(key: SecretKey): SecretKey {
  SecretNameSchema.parse(key.name);
  if (key.scope === "project" && !key.projectId) {
    throw new Error("A project-scoped secret needs a projectId.");
  }
  return key.scope === "project"
    ? { name: key.name, scope: "project", projectId: key.projectId }
    : { name: key.name, scope: "global" };
}

function slot(k: SecretKey): string {
  return `${k.scope}|${k.scope === "project" ? (k.projectId ?? "") : ""}|${k.name}`;
}

function parseSlot(s: string): SecretKey {
  const [scope, projectId, name] = s.split("|") as [SecretScope, string, string];
  return scope === "project" ? { name, scope, projectId } : { name, scope };
}

function keyOf(e: Entry): SecretKey {
  return e.scope === "project" ? { name: e.name, scope: e.scope, projectId: e.projectId } : { name: e.name, scope: e.scope };
}

function sameKey(a: SecretKey, b: SecretKey): boolean {
  return slot(a) === slot(b);
}

function decrypt(dataKey: Buffer, e: Entry): string {
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(e.iv, "base64"));
  decipher.setAAD(Buffer.from(slot(e), "utf8"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(e.data, "base64")), decipher.final()]).toString("utf8");
}
