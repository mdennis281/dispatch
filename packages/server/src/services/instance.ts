/**
 * Which instance this is, for plugins (E25): `ctx.instance`, and
 * `host.instance` through `GET /api/plugins/instance`.
 *
 * Stable and dev share `config/`, so nothing in it can tell them apart. Each
 * has its own data dir, so the identity lives there, in `instance.json`. A
 * file in the data dir is not an identity on its own, though. Dev's data dir
 * can be SEEDED by copying stable's, and the file comes along. A plugin that
 * namespaced remote work under the copied id would let dev's orphan sweep reap
 * stable's live sessions on the remote machine. So the record also pins the
 * directory it was minted for: the machine, the path and the volume's file id.
 * A record found in a directory it does not describe gets a new id, and the
 * old one is kept as `previousId` for the owner to adopt or clean up.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import type { PluginInstance, PluginInstanceRemintReason } from "@dispatch/shared";
import { installedRootPaths } from "./inspect.js";

export const INSTANCE_FILE = "instance.json";

/** The directory a record was minted for. Strings, because a file id is a 64-bit integer. */
interface DirIdentity {
  host: string;
  path: string;
  dev: string;
  ino: string;
}

interface InstanceRecord {
  v: 1;
  id: string;
  mintedAt: string;
  dir: DirIdentity;
  previousId?: string;
  reminted?: { at: string; reason: PluginInstanceRemintReason };
}

export interface ResolveInstanceOptions {
  dataDir: string;
  /** Started by `pnpm dev`, i.e. `start({ dev: true })`. */
  dev?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** `os.hostname()` unless a test says otherwise. */
  hostname?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Read this data dir's identity, minting or re-minting it as needed. Always
 * returns an identity. When the record can't be saved, the id it returns lasts
 * until the next restart. That fails safe: a plugin leaks work under an id
 * nobody reuses, and never adopts someone else's.
 */
export function resolveInstance(opts: ResolveInstanceOptions): PluginInstance {
  const log = opts.log ?? ((line: string) => console.warn(`[Dispatch] ${line}`));
  const file = join(opts.dataDir, INSTANCE_FILE);
  mkdirSync(opts.dataDir, { recursive: true });
  const here = describeDir(opts.dataDir, opts.hostname ?? osHostname());
  const stored = readRecord(file, log);
  const at = (opts.now?.() ?? new Date()).toISOString();

  let record: InstanceRecord;
  if (!stored) {
    record = { v: 1, id: randomUUID(), mintedAt: at, dir: here };
  } else if (sameDir(stored.dir, here)) {
    // Still this directory, possibly under a new name: the id stays, and the
    // record follows it so a later copy is judged against where it is now.
    record = { ...stored, dir: here };
  } else {
    const reason = remintReason(stored, here);
    record = { v: 1, id: randomUUID(), mintedAt: at, dir: here, previousId: stored.id, reminted: { at, reason } };
    log(
      `instance: ${opts.dataDir} holds the id minted for ${stored.dir.path} on ${stored.dir.host} (${reason}); ` +
        `it has a new id now, and plugins see the old one as previousId`,
    );
  }
  if (!stored || stored.id !== record.id || !sameIdentity(stored.dir, record.dir)) writeRecord(file, record, log);

  return {
    id: record.id,
    role: instanceRole(opts.dataDir, opts.dev ?? false, opts.env, opts.home),
    dataDirFingerprint: fingerprint(here),
    ...(record.previousId ? { previousId: record.previousId } : {}),
    ...(record.reminted ? { reminted: record.reminted } : {}),
  };
}

/**
 * `stable` when this process serves the installed deployment's data dir, the
 * same line `installedRoots` draws. Then `dev` for `pnpm dev`, and `other`
 * for anything else.
 */
export function instanceRole(
  dataDir: string,
  dev: boolean,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): PluginInstance["role"] {
  if (samePath(canonical(dataDir), canonical(installedRootPaths(env, home).dataDir))) return "stable";
  return dev ? "dev" : "other";
}

function sameDir(recorded: DirIdentity, here: DirIdentity): boolean {
  // Another machine. A data dir carried to a new PC while the old one still
  // runs must not answer to the old one's id. Both re-mint on a PC rename too,
  // which is the price: their remote work shows up under `previousId`.
  if (fold(recorded.host) !== fold(here.host)) return false;
  // The same place. A copy can never land here: two live directories can't
  // share a path, so this is the directory itself, restored in place or on a
  // filesystem whose file ids don't survive a remount.
  if (samePath(recorded.path, here.path)) return true;
  // The same directory under a new name: renamed, or moved within the volume.
  // A copy never matches, because it exists alongside its original, and two
  // live files on one volume never share a file id. Zero means the filesystem
  // has no stable file id, so there is nothing to compare.
  return here.ino !== "0" && recorded.dev === here.dev && recorded.ino === here.ino;
}

function remintReason(stored: InstanceRecord, here: DirIdentity): PluginInstanceRemintReason {
  if (fold(stored.dir.host) !== fold(here.host)) return "hostname";
  // The original still holding the same id is the case that matters: two
  // instances that would otherwise answer to one id. A plugin should treat
  // `previousId` as live there.
  const original = readRecord(join(stored.dir.path, INSTANCE_FILE), () => {});
  return original?.id === stored.id ? "copied" : "moved";
}

function describeDir(dataDir: string, host: string): DirIdentity {
  const path = canonical(dataDir);
  const st = statSync(path, { bigint: true });
  return { host, path, dev: String(st.dev), ino: String(st.ino) };
}

function fingerprint(d: DirIdentity): string {
  return createHash("sha256")
    .update([fold(d.host), foldPath(d.path), d.dev, d.ino].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

function readRecord(file: string, log: (line: string) => void): InstanceRecord | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const r = JSON.parse(raw) as Partial<InstanceRecord> | null;
    const d = r?.dir;
    if (
      typeof r?.id === "string" &&
      r.id &&
      d &&
      typeof d.host === "string" &&
      typeof d.path === "string" &&
      typeof d.dev === "string" &&
      typeof d.ino === "string"
    ) {
      return r as InstanceRecord;
    }
  } catch {
    // Fall through: unreadable is the same as absent, a fresh id.
  }
  log(`instance: ${file} is unreadable; minting a new id`);
  return null;
}

function writeRecord(file: string, record: InstanceRecord, log: (line: string) => void): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Leftover temp file; the next boot writes its own.
    }
    log(`instance: could not save ${file} (${err instanceof Error ? err.message : String(err)}); this id lasts until restart`);
  }
}

function sameIdentity(a: DirIdentity, b: DirIdentity): boolean {
  return a.host === b.host && a.path === b.path && a.dev === b.dev && a.ino === b.ino;
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

const fold = (s: string) => s.toLowerCase();
const foldPath = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
const samePath = (a: string, b: string) => foldPath(a) === foldPath(b);
