/**
 * ArtifactService — the store behind the `dispatch-artifacts` tools and the
 * viewer's routes. See `@dispatch/shared/artifacts.ts` for what an artifact IS.
 *
 * Layout, per chat:
 *
 *   chats/<chatId>/artifacts/<artifactId>/meta.json
 *   chats/<chatId>/artifacts/<artifactId>/v1.html, v2.html, …
 *
 * Inside the chat dir so a deleted chat takes its artifacts with it and
 * `backsync` carries them across with the chat; a SIBLING of `assets/` so the
 * asset route — which serves anything in there by name, same-origin — can never
 * be pointed at one. Agent-written HTML must only ever reach a browser through
 * the sandboxed viewer.
 */
import { readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import {
  ARTIFACT_ERROR_MAX_CHARS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_ERRORS,
  ARTIFACT_MAX_VERSIONS,
  ARTIFACT_TITLE_MAX,
  ArtifactMetaSchema,
  applyArtifactEdit,
  artifactExtension,
  latestArtifactVersion,
  type ArtifactMeta,
  type ArtifactType,
} from "@dispatch/shared";
import { KeyedMutex, isMissing, readJson, writeJsonAtomic } from "../store/fsq.js";

/**
 * Shape of an artifact id. Checked on EVERY id that arrives from outside — a
 * tool argument or a URL segment — before it is joined onto a path, so `..` or
 * a drive letter can never name a directory outside the chat's artifacts.
 */
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type ArtifactErrorCode = "not_found" | "expired" | "too_large" | "edit_failed" | "invalid";

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
    readonly expiredAt?: number,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface ArtifactServiceDeps {
  /** `Store.chatArtifactsDir` — which also validates the chat id. */
  dirFor: (chatId: string) => string;
  now?: () => number;
}

export interface ArtifactWrite {
  title?: string;
  type?: ArtifactType;
  language?: string;
  content: string;
}

export interface ArtifactEdit {
  /** Replace the whole content. */
  content?: string;
  /** Or apply one exact-match replacement to the current version. */
  edit?: { oldStr: string; newStr: string };
  title?: string;
}

/**
 * Runtime errors are kept in memory, not on disk: they describe one render of
 * one version in one browser, they are only useful while the agent is still
 * iterating, and a restart losing them costs one re-render. Bounded so a page
 * that throws on every animation frame across hundreds of artifacts cannot
 * grow the map for the life of the process.
 */
const ERROR_KEYS_MAX = 500;

export class ArtifactService {
  private readonly dirFor: (chatId: string) => string;
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();
  private readonly errors = new Map<string, string[]>();

  constructor(deps: ArtifactServiceDeps) {
    this.dirFor = deps.dirFor;
    this.now = deps.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- paths */

  private artifactDir(chatId: string, id: string): string {
    if (!ARTIFACT_ID.test(id)) throw new ArtifactError("invalid", `"${id}" is not an artifact id.`);
    return join(this.dirFor(chatId), id);
  }
  private metaPath(chatId: string, id: string): string {
    return join(this.artifactDir(chatId, id), "meta.json");
  }
  private versionPath(chatId: string, meta: ArtifactMeta, n: number): string {
    return join(this.artifactDir(chatId, meta.id), `v${n}.${artifactExtension(meta.type, meta.language)}`);
  }

  /* ---------------------------------------------------------------- reads */

  async getMeta(chatId: string, id: string): Promise<ArtifactMeta | null> {
    const raw = await readJson(this.metaPath(chatId, id)).catch(() => undefined);
    const parsed = ArtifactMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** Every artifact in a chat, most recently edited first. `[]` when none. */
  async list(chatId: string): Promise<ArtifactMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dirFor(chatId));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const metas = await Promise.all(
      names.filter((n) => ARTIFACT_ID.test(n)).map((n) => this.getMeta(chatId, n)),
    );
    return metas.filter((m): m is ArtifactMeta => !!m).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One version's content (default: the newest). Throws `ArtifactError`. */
  async read(
    chatId: string,
    id: string,
    version?: number,
  ): Promise<{ meta: ArtifactMeta; version: number; content: string; errors: string[] }> {
    const meta = await this.getMeta(chatId, id);
    if (!meta) throw new ArtifactError("not_found", `No artifact "${id}" in this chat.`);
    if (meta.expiredAt !== undefined) {
      throw new ArtifactError(
        "expired",
        `Artifact "${id}" expired on ${new Date(meta.expiredAt).toISOString().slice(0, 10)} and its content was deleted.`,
        meta.expiredAt,
      );
    }
    const n = version ?? latestArtifactVersion(meta);
    if (!meta.versions.some((v) => v.n === n)) {
      const have = meta.versions.map((v) => v.n);
      throw new ArtifactError(
        "not_found",
        `Artifact "${id}" has no version ${n} (kept: ${have.length ? `${have[0]}–${have.at(-1)}` : "none"}).`,
      );
    }
    const content = await readFile(this.versionPath(chatId, meta, n), "utf8").catch((err: unknown) => {
      if (isMissing(err)) throw new ArtifactError("not_found", `Version ${n} of "${id}" is missing on disk.`);
      throw err;
    });
    return { meta, version: n, content, errors: this.errorsFor(chatId, id, n) };
  }

  /* --------------------------------------------------------------- writes */

  async create(chatId: string, input: ArtifactWrite & { title: string; type: ArtifactType }): Promise<ArtifactMeta> {
    const id = nanoid(10);
    const now = this.now();
    const meta: ArtifactMeta = {
      id,
      chatId,
      title: cleanTitle(input.title),
      type: input.type,
      ...(input.type === "code" && input.language ? { language: input.language.slice(0, 32) } : {}),
      createdAt: now,
      updatedAt: now,
      versions: [],
    };
    return this.mutex.run(`${chatId}:${id}`, async () => {
      await mkdir(this.artifactDir(chatId, id), { recursive: true });
      return this.appendVersion(chatId, meta, input.content);
    });
  }

  /** A new version from a full replacement or one exact-match edit. Throws `ArtifactError`. */
  async update(chatId: string, id: string, change: ArtifactEdit): Promise<ArtifactMeta> {
    return this.mutex.run(`${chatId}:${id}`, async () => {
      // Read under the lock: two edits racing must each apply to the version
      // the other produced, or the second silently reverts the first.
      const current = await this.read(chatId, id);
      let next = current.content;
      if (change.content !== undefined) next = change.content;
      else if (change.edit) {
        const applied = applyArtifactEdit(current.content, change.edit.oldStr, change.edit.newStr);
        if (!applied.ok) throw new ArtifactError("edit_failed", applied.error);
        next = applied.content;
      }
      const meta: ArtifactMeta = {
        ...current.meta,
        ...(change.title !== undefined ? { title: cleanTitle(change.title) } : {}),
      };
      // A title-only change still cuts a version: the card in the transcript
      // names a version, and two cards naming the same one would disagree.
      return this.appendVersion(chatId, meta, next);
    });
  }

  private async appendVersion(chatId: string, meta: ArtifactMeta, content: string): Promise<ArtifactMeta> {
    const size = Buffer.byteLength(content, "utf8");
    if (size > ARTIFACT_MAX_BYTES) {
      throw new ArtifactError(
        "too_large",
        `Artifact content is ${size} bytes; the limit is ${ARTIFACT_MAX_BYTES}. Split it, or link the file instead.`,
      );
    }
    const now = this.now();
    const n = latestArtifactVersion(meta) + 1;
    await writeFile(this.versionPath(chatId, meta, n), content, "utf8");
    let versions = [...meta.versions, { n, createdAt: now, size }];
    const dropped = versions.length > ARTIFACT_MAX_VERSIONS ? versions.slice(0, versions.length - ARTIFACT_MAX_VERSIONS) : [];
    versions = versions.slice(dropped.length);
    const next: ArtifactMeta = { ...meta, updatedAt: now, versions };
    await writeJsonAtomic(this.metaPath(chatId, meta.id), next);
    // Meta first, files second: a crash between the two leaves an orphan file
    // nobody names, never a meta naming a file that is gone.
    for (const v of dropped) await rm(this.versionPath(chatId, meta, v.n), { force: true }).catch(() => {});
    return next;
  }

  /* --------------------------------------------------------------- errors */

  private errorKey(chatId: string, id: string, version: number): string {
    return `${chatId}:${id}:${version}`;
  }

  /** What the viewer reported for one version. Deduped, clipped and bounded. */
  recordErrors(chatId: string, id: string, version: number, reported: string[]): void {
    if (!ARTIFACT_ID.test(id)) return;
    const key = this.errorKey(chatId, id, version);
    const list = this.errors.get(key) ?? [];
    for (const raw of reported) {
      const msg = String(raw).slice(0, ARTIFACT_ERROR_MAX_CHARS).trim();
      if (!msg || list.includes(msg)) continue;
      list.push(msg);
    }
    while (list.length > ARTIFACT_MAX_ERRORS) list.shift();
    // Re-insert so Map order is recency and eviction takes the stalest key.
    this.errors.delete(key);
    this.errors.set(key, list);
    while (this.errors.size > ERROR_KEYS_MAX) {
      const oldest = this.errors.keys().next().value;
      if (oldest === undefined) break;
      this.errors.delete(oldest);
    }
  }

  errorsFor(chatId: string, id: string, version: number): string[] {
    return [...(this.errors.get(this.errorKey(chatId, id, version)) ?? [])];
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Delete the content of every artifact whose last edit is older than the
   * window, keeping its meta with `expiredAt` set. Measured from the last EDIT,
   * not creation: an artifact the agent is still revising is in use.
   */
  async sweep(chatIds: string[], windowMs: number): Promise<{ artifacts: number; bytes: number; chats: number }> {
    const cutoff = this.now() - windowMs;
    let artifacts = 0;
    let bytes = 0;
    let chats = 0;
    for (const chatId of chatIds) {
      let touched = false;
      for (const meta of await this.list(chatId).catch(() => [] as ArtifactMeta[])) {
        if (meta.expiredAt !== undefined || meta.updatedAt > cutoff) continue;
        const freed = await this.mutex.run(`${chatId}:${meta.id}`, () => this.expire(chatId, meta.id));
        if (freed === null) continue;
        artifacts++;
        bytes += freed;
        touched = true;
      }
      if (touched) chats++;
    }
    return { artifacts, bytes, chats };
  }

  /** Bytes freed, or null when it was already expired / gone. */
  private async expire(chatId: string, id: string): Promise<number | null> {
    const meta = await this.getMeta(chatId, id);
    if (!meta || meta.expiredAt !== undefined) return null;
    let freed = 0;
    const dir = this.artifactDir(chatId, id);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name === "meta.json") continue;
      const path = join(dir, name);
      const size = (await stat(path).catch(() => null))?.size ?? 0;
      try {
        await rm(path);
        freed += size;
      } catch (err) {
        // Held open on Windows: leave the artifact unexpired so the next pass
        // retries, rather than recording an expiry that didn't happen.
        if (!isMissing(err)) return null;
      }
    }
    await writeJsonAtomic(this.metaPath(chatId, id), { ...meta, expiredAt: this.now() });
    for (const v of meta.versions) this.errors.delete(this.errorKey(chatId, id, v.n));
    return freed;
  }
}

function cleanTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, ARTIFACT_TITLE_MAX);
  return t || "Untitled artifact";
}
