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
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import {
  ARTIFACT_ASSET_MAX_BYTES,
  ARTIFACT_ASSETS_MAX_BYTES,
  ARTIFACT_ASSETS_MAX_FILES,
  ARTIFACT_BLOB_ID,
  ARTIFACT_ERROR_MAX_CHARS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_ERRORS,
  ARTIFACT_MAX_VERSIONS,
  ARTIFACT_STORAGE_MAX_CHARS,
  ARTIFACT_TITLE_MAX,
  ArtifactMetaSchema,
  applyArtifactEdit,
  artifactAssetType,
  artifactExtension,
  artifactStorageChars,
  normalizeAssetPath,
  latestArtifactVersion,
  type ArtifactAsset,
  type ArtifactMeta,
  type ArtifactStorage,
  type ArtifactStoragePatch,
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
  /**
   * `Store.chatArtifactBlobsDir`: the chat's content-addressed asset bytes.
   * Omitted → this service refuses assets (tests about other things).
   */
  blobDirFor?: (chatId: string) => string;
  now?: () => number;
}

/** One file to bundle: where it is on disk, and the path the page asks for it by. */
export interface ArtifactAssetInput {
  path: string;
  /** Absolute path, already confined by the caller (see `readSource` in artifact-tools). */
  file: string;
}

export interface ArtifactWrite {
  title?: string;
  type?: ArtifactType;
  language?: string;
  content: string;
  assets?: ArtifactAssetInput[];
}

export interface ArtifactEdit {
  /** Replace the whole content. */
  content?: string;
  /** Or apply one exact-match replacement to the current version. */
  edit?: { oldStr: string; newStr: string };
  title?: string;
  /**
   * The new version's assets: a list replaces them, `null` drops them, and
   * omitted CARRIES THE PREVIOUS VERSION'S FORWARD — an edit to one line of a
   * game must not orphan its textures.
   */
  assets?: ArtifactAssetInput[] | null;
}

/**
 * A blob nobody references is only deleted once it is at least this old. A
 * create stores its blobs BEFORE it writes the meta naming them, so a sweep
 * landing in between would otherwise delete the bytes of an artifact that is
 * one write from existing.
 */
const BLOB_GC_GRACE_MS = 60 * 60_000;

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
  private readonly blobDirFor?: (chatId: string) => string;
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();
  private readonly errors = new Map<string, string[]>();

  constructor(deps: ArtifactServiceDeps) {
    this.dirFor = deps.dirFor;
    this.blobDirFor = deps.blobDirFor;
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
  /**
   * The artifact's `localStorage`. Beside the versions rather than in the meta:
   * a game saving every few seconds must not rewrite the file every reader of
   * the artifact parses. Retention's `expire` deletes it with the versions —
   * anything that is not `meta.json` goes — so storage never outlives content.
   */
  private storagePath(chatId: string, id: string): string {
    return join(this.artifactDir(chatId, id), "storage.json");
  }
  /** Where a blob's bytes live, or null for a name that is not a content hash. */
  blobPath(chatId: string, sha256: string): string | null {
    if (!this.blobDirFor || !ARTIFACT_BLOB_ID.test(sha256)) return null;
    return join(this.blobDirFor(chatId), sha256);
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
  ): Promise<{
    meta: ArtifactMeta;
    version: number;
    content: string;
    errors: string[];
    assets?: Record<string, ArtifactAsset>;
  }> {
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
    const assets = meta.versions.find((v) => v.n === n)?.assets;
    return { meta, version: n, content, errors: this.errorsFor(chatId, id, n), ...(assets ? { assets } : {}) };
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
      // Size the main document BEFORE copying assets in: refusing an 9 MB page
      // after storing 200 MB of its textures is the expensive way to say no.
      assertContentSize(input.content);
      const assets = input.assets?.length ? await this.storeAssets(chatId, input.assets) : undefined;
      await mkdir(this.artifactDir(chatId, id), { recursive: true });
      return this.appendVersion(chatId, meta, input.content, assets);
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
      assertContentSize(next);
      const assets =
        change.assets === undefined
          ? current.assets
          : change.assets === null || !change.assets.length
            ? undefined
            : await this.storeAssets(chatId, change.assets);
      // A title-only change still cuts a version: the card in the transcript
      // names a version, and two cards naming the same one would disagree.
      return this.appendVersion(chatId, meta, next, assets);
    });
  }

  private async appendVersion(
    chatId: string,
    meta: ArtifactMeta,
    content: string,
    assets?: Record<string, ArtifactAsset>,
  ): Promise<ArtifactMeta> {
    const size = assertContentSize(content);
    const now = this.now();
    const n = latestArtifactVersion(meta) + 1;
    await writeFile(this.versionPath(chatId, meta, n), content, "utf8");
    let versions = [
      ...meta.versions,
      { n, createdAt: now, size, ...(assets && Object.keys(assets).length ? { assets } : {}) },
    ];
    const dropped = versions.length > ARTIFACT_MAX_VERSIONS ? versions.slice(0, versions.length - ARTIFACT_MAX_VERSIONS) : [];
    versions = versions.slice(dropped.length);
    const next: ArtifactMeta = { ...meta, updatedAt: now, versions };
    await writeJsonAtomic(this.metaPath(chatId, meta.id), next);
    // Meta first, files second: a crash between the two leaves an orphan file
    // nobody names, never a meta naming a file that is gone.
    for (const v of dropped) await rm(this.versionPath(chatId, meta, v.n), { force: true }).catch(() => {});
    return next;
  }

  /* --------------------------------------------------------------- assets */

  /**
   * Copy a version's files into the chat's blob store and return its manifest.
   *
   * Each file is copied to a temp name FIRST and hashed from the copy, then
   * renamed to its hash. Hashing the source and copying it separately would
   * let a file the agent is still writing (a build in progress) land under the
   * hash of different bytes. A blob that already exists is identical by
   * definition, so the copy is dropped — which is the whole point: version 7
   * of a game re-uses version 6's 200 MB of textures without storing them twice.
   *
   * Limits are checked from `stat` before anything is copied, so a refusal
   * costs a directory listing rather than the copy it refuses.
   */
  private async storeAssets(chatId: string, inputs: ArtifactAssetInput[]): Promise<Record<string, ArtifactAsset>> {
    if (!this.blobDirFor) throw new ArtifactError("invalid", "Assets aren't available here.");
    if (inputs.length > ARTIFACT_ASSETS_MAX_FILES) {
      throw new ArtifactError("too_large", `${inputs.length} asset files; the limit is ${ARTIFACT_ASSETS_MAX_FILES}.`);
    }
    const planned: Array<{ path: string; file: string; size: number }> = [];
    const seen = new Set<string>();
    let total = 0;
    for (const input of inputs) {
      const path = normalizeAssetPath(input.path);
      if (!path) throw new ArtifactError("invalid", `"${input.path}" is not a usable asset path.`);
      if (seen.has(path)) throw new ArtifactError("invalid", `Two assets map to "${path}".`);
      seen.add(path);
      const info = await stat(input.file).catch(() => null);
      if (!info?.isFile()) throw new ArtifactError("not_found", `No file at ${input.file}.`);
      if (info.size > ARTIFACT_ASSET_MAX_BYTES) {
        throw new ArtifactError("too_large", `${path} is ${info.size} bytes; one asset may be ${ARTIFACT_ASSET_MAX_BYTES}.`);
      }
      total += info.size;
      planned.push({ path, file: input.file, size: info.size });
    }
    if (total > ARTIFACT_ASSETS_MAX_BYTES) {
      throw new ArtifactError("too_large", `Assets total ${total} bytes; the limit is ${ARTIFACT_ASSETS_MAX_BYTES}.`);
    }
    const dir = this.blobDirFor(chatId);
    await mkdir(dir, { recursive: true });
    const manifest: Record<string, ArtifactAsset> = {};
    for (const p of planned) {
      const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
      try {
        await copyFile(p.file, tmp);
        const sha256 = await hashFile(tmp);
        const final = join(dir, sha256);
        const exists = await stat(final).then(() => true, () => false);
        if (exists) await rm(tmp, { force: true });
        else await rename(tmp, final);
        const size = (await stat(final)).size;
        manifest[p.path] = { sha256, size, type: artifactAssetType(p.path) };
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
    return manifest;
  }

  /**
   * Delete blobs no live version names. Run per chat by the sweep: version
   * pruning past {@link ARTIFACT_MAX_VERSIONS}, an update that replaced the
   * assets and expiry all leave bytes behind, and none of them can know whether
   * another artifact in the chat still uses the same file.
   */
  async gcBlobs(chatId: string): Promise<{ files: number; bytes: number }> {
    if (!this.blobDirFor) return { files: 0, bytes: 0 };
    const dir = this.blobDirFor(chatId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isMissing(err)) return { files: 0, bytes: 0 };
      throw err;
    }
    const referenced = new Set<string>();
    for (const meta of await this.list(chatId)) {
      if (meta.expiredAt !== undefined) continue;
      for (const v of meta.versions) for (const a of Object.values(v.assets ?? {})) referenced.add(a.sha256);
    }
    const cutoff = this.now() - BLOB_GC_GRACE_MS;
    let files = 0;
    let bytes = 0;
    for (const name of names) {
      // Temp files too: a copy that died mid-way leaves one behind.
      if (referenced.has(name)) continue;
      if (!ARTIFACT_BLOB_ID.test(name) && !name.startsWith(".tmp-")) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      try {
        await rm(path);
        files++;
        bytes += info.size;
      } catch {
        // Held open (a download streaming it): the next pass gets it.
      }
    }
    return { files, bytes };
  }

  /* -------------------------------------------------------------- storage */

  /** Live (not expired) meta, or the `ArtifactError` a storage call should fail with. */
  private async liveMeta(chatId: string, id: string): Promise<ArtifactMeta> {
    const meta = await this.getMeta(chatId, id);
    if (!meta) throw new ArtifactError("not_found", `No artifact "${id}" in this chat.`);
    if (meta.expiredAt !== undefined) {
      throw new ArtifactError("expired", `Artifact "${id}" has expired.`, meta.expiredAt);
    }
    return meta;
  }

  private async readEntries(chatId: string, id: string): Promise<Record<string, string>> {
    const raw = await readJson(this.storagePath(chatId, id)).catch(() => undefined);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  async readStorage(chatId: string, id: string): Promise<ArtifactStorage> {
    await this.liveMeta(chatId, id);
    const entries = await this.readEntries(chatId, id);
    return { entries, chars: artifactStorageChars(entries) };
  }

  /**
   * Apply one batch from the viewer: `clear` first, then `set` (null removes).
   * Refused WHOLE when the result would exceed the quota — a half-applied batch
   * is a save file with half a save in it. The page's own shim enforces the
   * same quota synchronously, so in practice this only catches a page that
   * bypassed it.
   */
  async writeStorage(chatId: string, id: string, patch: ArtifactStoragePatch): Promise<ArtifactStorage> {
    return this.mutex.run(`${chatId}:${id}`, async () => {
      await this.liveMeta(chatId, id);
      const entries: Record<string, string> = patch.clear ? {} : await this.readEntries(chatId, id);
      for (const [k, v] of Object.entries(patch.set)) {
        if (v === null) delete entries[k];
        else entries[k] = v;
      }
      const chars = artifactStorageChars(entries);
      if (chars > ARTIFACT_STORAGE_MAX_CHARS) {
        throw new ArtifactError(
          "too_large",
          `Artifact storage would be ${chars} characters; the quota is ${ARTIFACT_STORAGE_MAX_CHARS}.`,
        );
      }
      if (Object.keys(entries).length === 0) {
        await rm(this.storagePath(chatId, id), { force: true });
      } else {
        await writeJsonAtomic(this.storagePath(chatId, id), entries);
      }
      return { entries, chars };
    });
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
        const freed = await this.mutex.run(`${chatId}:${meta.id}`, () => this.expire(chatId, meta.id, cutoff));
        if (freed === null) continue;
        artifacts++;
        bytes += freed;
        touched = true;
      }
      // After the expiries, so this pass frees what it just orphaned.
      const gc = await this.gcBlobs(chatId).catch(() => ({ files: 0, bytes: 0 }));
      bytes += gc.bytes;
      if (touched || gc.files) chats++;
    }
    return { artifacts, bytes, chats };
  }

  /** Bytes freed, or null when it was already expired, gone, or no longer stale. */
  private async expire(chatId: string, id: string, cutoff: number): Promise<number | null> {
    const meta = await this.getMeta(chatId, id);
    if (!meta || meta.expiredAt !== undefined) return null;
    // Re-judged UNDER the lock: the candidate list is a snapshot, and an
    // `artifact_update` that landed after it was taken has just written a
    // version this would otherwise delete.
    if (meta.updatedAt > cutoff) return null;
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

/** Bytes of a main document, or the refusal past {@link ARTIFACT_MAX_BYTES}. */
function assertContentSize(content: string): number {
  const size = Buffer.byteLength(content, "utf8");
  if (size > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError(
      "too_large",
      `Artifact content is ${size} bytes; the limit is ${ARTIFACT_MAX_BYTES}. ` +
        `Move textures, models, audio and wasm into assets instead of inlining them.`,
    );
  }
  return size;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function cleanTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, ARTIFACT_TITLE_MAX);
  return t || "Untitled artifact";
}
