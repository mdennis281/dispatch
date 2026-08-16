/**
 * ReleaseService — "is there a newer Dispatch than the one I am?"
 *
 * The installed app is a release tarball, not a git clone: `%LOCALAPPDATA%\
 * claude-manager\app` has no `.git`, which is why `health.ts`'s `payloadSha()`
 * comes back empty there. The authoritative answer to "which build is this" is
 * `app/release-manifest.json`, written by `tools/release/package.mjs`, plus
 * `<root>/current.json`, written by `tools/install.mjs`. Until now nothing in
 * the server read either file, so the app could not tell the user it was stale.
 *
 * Three rules this service is built around:
 *
 *   1. **No manifest means unsupported, not "up to date".** A dev checkout run
 *      from source has no `release-manifest.json` and no installer that would
 *      know what to replace. It must report `supported: false` so the UI hides
 *      every update affordance rather than offering one that cannot work.
 *   2. **A failed check never destroys a good answer.** Offline, rate-limited,
 *      DNS-dead and 500-from-GitHub all keep the previous result and record an
 *      `error`. Blanking the status on a flaky network would make the nudge
 *      flicker in and out for anyone on hotel wifi.
 *   3. **Never block startup.** The first check is deferred and the interval is
 *      unref'd, so an unreachable GitHub delays nothing and holds nothing open.
 *
 * Auth: anonymous `api.github.com` works once the repo is public, and
 * `GITHUB_TOKEN`/`GH_TOKEN` is honored exactly as `tools/install.mjs:113-122`
 * does. While the repo is PRIVATE neither applies — the server process has no
 * token in its environment — so a 401/403/404 falls back to `gh api`, which
 * already backs `services/github.ts` and carries the user's own credentials.
 *
 * CHANNELS. A channel is the GitHub `prerelease` flag. Stable is still exactly
 * `releases/latest`, which GitHub filters prereleases out of server-side — the
 * proven path, and one that cannot be broken by a paging bug here. Unstable
 * lists releases and picks the newest build stamp itself, which is why it also
 * sees promoted (no longer prerelease) builds: promotion must never look like a
 * regression to someone on unstable.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type {
  InstalledRelease,
  LatestRelease,
  UpdateChannel,
  UpdateStatus,
} from "@dispatch/shared";
import { compareBuildVersions } from "@dispatch/shared";
import type { EventBus } from "../bus.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo the installer defaults to; `DISPATCH_INSTALL_REPO` overrides both. */
const DEFAULT_REPO = "mdennis281/dispatch";

/** Long enough that a poll is a rounding error, short enough to notice a release the same day. */
const DEFAULT_POLL_MS = 6 * 60 * 60 * 1000;

/** Startup grace before the first check — boot has better things to do. */
const DEFAULT_FIRST_CHECK_MS = 30_000;

/** A check that has not answered by now is not going to; the next tick retries. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Floor between manual "Check now" clicks, so the button cannot be leaned on. */
const MIN_MANUAL_GAP_MS = 10_000;

/**
 * How many releases the unstable channel looks back over.
 *
 * The unstable head is by definition the newest release, so one page is always
 * enough to find it; the depth only buys tolerance for drafts and unorderable
 * tags near the top. Stable deliberately does NOT page — it asks GitHub for
 * `releases/latest` — so a long unstable run can never push the stable head off
 * the end of a list this code had to paginate correctly.
 */
const UNSTABLE_PAGE_SIZE = 30;

/** Where the channel subscription is persisted; `config/`, so updates never reset it. */
export interface ReleaseChannelStore {
  read(): Promise<UpdateChannel>;
  write(channel: UpdateChannel): Promise<void>;
}

export interface ReleaseServiceDeps {
  bus: EventBus;
  /** Persistence for the channel subscription. Omitted in tests → in-memory only. */
  channelStore?: ReleaseChannelStore;
  /** Starting channel before `hydrate()` runs, and the value tests inject. */
  channel?: UpdateChannel;
  /** Injected in tests so no real network or `gh` is touched. */
  fetchImpl?: typeof fetch;
  execImpl?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
  now?: () => number;
  pollMs?: number;
  firstCheckMs?: number;
  /** Payload directory to read `release-manifest.json` from. Defaults to the running payload. */
  appDir?: string;
  repo?: string;
  env?: NodeJS.ProcessEnv;
}

/** How far up to look for the payload root before giving up. */
const MANIFEST_SEARCH_DEPTH = 8;

/**
 * Where the running payload lives — the directory holding `release-manifest.json`.
 *
 * Found by walking UP from this module rather than by counting directory levels
 * off it. The count is exactly the kind of thing that is right when written and
 * wrong later: this file compiles to `dist/services/release.js`, one level
 * deeper than `health.ts`'s `dist/health.js`, so the obvious "../../.." that
 * matches the sibling module is off by one and silently reports every install as
 * a source checkout. A search for the file we actually want cannot drift.
 *
 * Derived from this module's location, not `process.cwd()`: the launcher starts
 * the server with its cwd set to `app/packages/server`, and a future launcher
 * change must not move where the version is read from.
 *
 * Falls back to the four-levels-up path so callers always get a directory to
 * name in an error; `readInstalledRelease` will simply find nothing there.
 */
export function payloadAppDir(): string {
  let dir = here;
  for (let i = 0; i < MANIFEST_SEARCH_DEPTH; i++) {
    if (existsSync(join(dir, "release-manifest.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return resolve(here, "../../../..");
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    // `readFileSync(…, "utf8")` does not strip a BOM and `JSON.parse` rejects
    // one, so a manifest that ever passes through a Windows editor or a
    // PowerShell `Set-Content -Encoding utf8` would silently disable updates
    // forever — the failure looks exactly like "this is a source checkout".
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Missing (a dev checkout), unreadable, or corrupt all mean the same thing
    // to a caller: there is no release identity to be had here.
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Identify the running payload, or `null` when this is not a release install.
 *
 * `current.json` sits one level above the payload and survives the swap, so it
 * is the only place `installedAt` exists — but it describes whatever the
 * installer put down LAST, which after a rollback is not what is running. So the
 * manifest inside the payload is the source of truth for version/tag/sha, and
 * `current.json` is consulted only for the timestamp, and only when its version
 * still matches.
 */
export function readInstalledRelease(appDir = payloadAppDir()): InstalledRelease | null {
  const manifest = readJsonFile(join(appDir, "release-manifest.json"));
  const version = str(manifest?.version);
  const tag = str(manifest?.tag);
  if (!manifest || !version || !tag) return null;

  const stamp = readJsonFile(join(resolve(appDir, ".."), "current.json"));
  const installedAt = str(stamp?.version) === version ? str(stamp?.installedAt) : undefined;

  return {
    version,
    tag,
    ...(str(manifest.sha) ? { sha: str(manifest.sha)! } : {}),
    ...(str(manifest.builtAt) ? { builtAt: str(manifest.builtAt)! } : {}),
    ...(installedAt ? { installedAt } : {}),
  };
}

/** The subset of the GitHub release payload we depend on. */
interface RawRelease {
  tag_name?: unknown;
  html_url?: unknown;
  name?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function toLatest(raw: RawRelease, allowPrerelease = false): LatestRelease | null {
  const tag = str(raw.tag_name);
  if (!tag) return null;
  // A DRAFT is refused unconditionally and on both channels: its assets may not
  // exist yet, so offering one advertises an update the installer would then
  // fail to download. `tools/install.mjs` refuses drafts for the same reason.
  if (raw.draft === true) return null;
  // A PRERELEASE is the unstable channel — offering one on stable would hand the
  // installer a tag it is explicitly asked to skip when resolving a channel head.
  if (raw.prerelease === true && !allowPrerelease) return null;
  return {
    version: tag.startsWith("v") ? tag.slice(1) : tag,
    tag,
    url: str(raw.html_url) ?? `https://github.com/${DEFAULT_REPO}/releases/tag/${tag}`,
    ...(str(raw.name) ? { name: str(raw.name)! } : {}),
    ...(str(raw.published_at) ? { publishedAt: str(raw.published_at)! } : {}),
  };
}

export class ReleaseService {
  private readonly bus: EventBus;
  private readonly fetchImpl: typeof fetch;
  private readonly execImpl: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly firstCheckMs: number;
  private readonly appDir: string;
  private readonly repo: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly channelStore: ReleaseChannelStore | undefined;

  private channel: UpdateChannel;
  private readonly installed: InstalledRelease | null;
  private latest: LatestRelease | null = null;
  private checkedAt: number | null = null;
  private lastError: string | undefined;
  /**
   * "The switch took effect but could not be written down."
   *
   * Kept apart from `lastError` because `runCheck` clears that one on every
   * success, and the re-check `setChannel` fires immediately afterwards would
   * therefore erase this the instant it was set — leaving a channel that
   * silently reverts on restart with nothing anywhere saying why.
   */
  private channelPersistError: string | undefined;
  /** `If-None-Match` for the next poll; a 304 costs no rate-limit quota. */
  private etag: string | undefined;
  private installing = false;
  /**
   * Ms epoch the latch was set. `update.json` is not written until the installer
   * is actually spawned — after the reply flushes, plus `SETTLE_MS` — so for a
   * moment the newest stamp on disk belongs to the PREVIOUS install. Anything
   * reading that stamp has to be able to tell it is stale, or it reports the
   * last update's outcome as this one's.
   */
  private installingSinceMs: number | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight check, so concurrent callers coalesce onto one request. */
  private inflight: Promise<UpdateStatus> | null = null;
  /** Version we have already announced, so one release nudges once per server. */
  private announced: string | null = null;

  constructor(deps: ReleaseServiceDeps) {
    this.bus = deps.bus;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.execImpl =
      deps.execImpl ?? ((file, args) => execa(file, args as string[]) as Promise<{ stdout: string }>);
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.firstCheckMs = deps.firstCheckMs ?? DEFAULT_FIRST_CHECK_MS;
    this.appDir = deps.appDir ?? payloadAppDir();
    this.env = deps.env ?? process.env;
    this.repo = deps.repo ?? this.env.DISPATCH_INSTALL_REPO ?? DEFAULT_REPO;
    this.channelStore = deps.channelStore;
    this.channel = deps.channel ?? "stable";
    this.installed = readInstalledRelease(this.appDir);
  }

  /** True only for a payload installed from a release — see rule 1 in the header. */
  get supported(): boolean {
    return this.installed !== null;
  }

  /**
   * Load the persisted channel. Awaited during boot BEFORE `start()`, so the
   * very first check already asks the right channel and `GET /api/update` never
   * answers "stable" to someone who is on unstable.
   */
  async hydrate(): Promise<void> {
    if (!this.channelStore) return;
    try {
      this.channel = await this.channelStore.read();
    } catch {
      // A stored value we cannot read is not worth failing boot over; `stable`
      // is the safe side of that coin — it can only ever under-offer.
    }
  }

  /**
   * Switch channels and immediately re-check.
   *
   * The etag is dropped rather than kept per-channel: it belongs to the URL we
   * just stopped asking, and a `304` replayed against the other channel's
   * endpoint would strand the UI showing the old channel's head as the new
   * channel's answer. `announced` is dropped too, so crossing to a channel whose
   * head you have already been told about still nudges once.
   */
  async setChannel(next: UpdateChannel): Promise<UpdateStatus> {
    if (next === this.channel) return this.check(true);
    this.channel = next;
    this.etag = undefined;
    this.latest = null;
    this.announced = null;
    this.checkedAt = null;
    this.lastError = undefined;
    this.channelPersistError = undefined;
    if (this.channelStore) {
      try {
        await this.channelStore.write(next);
      } catch (err) {
        this.channelPersistError = `channel saved for this session only: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    return this.check(true);
  }

  /**
   * The tag `POST /api/update/install` is allowed to install — the head of the
   * subscribed channel and nothing else. Exposed so the route can validate an
   * explicitly requested tag without being handed the power to fetch any tag.
   */
  headTag(): string | null {
    return this.latest?.tag ?? null;
  }

  /** Begin polling. A no-op on an unsupported payload: nothing would use the answer. */
  start(): void {
    if (!this.supported || this.timer) return;
    this.firstTimer = setTimeout(() => void this.check().catch(() => {}), this.firstCheckMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.check().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  /** The current answer, without touching the network. */
  status(): UpdateStatus {
    return {
      supported: this.supported,
      installed: this.installed,
      latest: this.latest,
      available: this.isAvailable(),
      checkedAt: this.checkedAt,
      channel: this.channel,
      ...(this.isAhead() ? { ahead: true } : {}),
      // Both can be true at once (a switch that neither persisted nor reached
      // GitHub), and each names a different thing that is wrong. Neither may
      // swallow the other.
      ...(this.lastError || this.channelPersistError
        ? {
            error: [this.channelPersistError, this.lastError].filter(Boolean).join(" — "),
          }
        : {}),
      ...(this.installing ? { installing: true } : {}),
    };
  }

  /** Latch "an install was launched" so the status stops advertising the button. */
  markInstalling(): void {
    this.installing = true;
    this.installingSinceMs = Date.now();
  }

  /** When the latch was set, or null if no install was launched from this process. */
  installingSince(): number | null {
    return this.installingSinceMs;
  }

  /**
   * Un-latch it when the launch never happened.
   *
   * The flag is set BEFORE the spawn so two clicks cannot race two installers at
   * one `app/` rename — which means a spawn that throws (no Node on PATH, the
   * bundled installer missing, a permission error) would otherwise leave this
   * server reporting `installing: true` for the rest of its life, with the UI
   * stuck on a restart that is never coming and no way to retry but a restart.
   */
  clearInstalling(): void {
    this.installing = false;
    this.installingSinceMs = null;
  }

  /**
   * Check now, coalescing concurrent callers and floor-spacing manual clicks.
   * Never rejects: a failure is reported in the status, not thrown at a route.
   */
  async check(force = false): Promise<UpdateStatus> {
    if (!this.supported) return this.status();
    if (this.inflight) return this.inflight;
    if (force && this.checkedAt !== null && this.now() - this.checkedAt < MIN_MANUAL_GAP_MS) {
      return this.status();
    }
    this.inflight = this.runCheck().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private isAvailable(): boolean {
    if (!this.installed || !this.latest) return false;
    // `null` from the comparator means the two tags cannot be ordered (a semver
    // release, say). That reads as "no update known" on purpose — see the
    // comparator's own note in packages/shared/src/version.ts.
    //
    // Still strictly `-1`, even now that a step-back is reachable: a downgrade
    // is something the user asks for by name, never something `available` turns
    // on and the standing nudge card starts pushing.
    return compareBuildVersions(this.installed.version, this.latest.version) === -1;
  }

  /**
   * Running a build the subscribed channel has not caught up to.
   *
   * The unstable → stable case: you are on a merge that stable has not been
   * promoted to yet. There is no update, but there is something to say and
   * something to offer, and reporting it as a plain "up to date" would make the
   * channel switch look like it did nothing for however long until the next
   * promote.
   */
  private isAhead(): boolean {
    if (!this.installed || !this.latest) return false;
    return compareBuildVersions(this.installed.version, this.latest.version) === 1;
  }

  private async runCheck(): Promise<UpdateStatus> {
    try {
      const result = await this.fetchLatest();
      // A 304 means "unchanged": keep `latest` and the etag, and still stamp
      // `checkedAt` so the UI can say when it last looked.
      if (result !== "not-modified") this.latest = result;
      this.checkedAt = this.now();
      this.lastError = undefined;
    } catch (err) {
      // Rule 2: the previous `latest` survives. Only the error text is new.
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    const status = this.status();
    if (status.available && status.latest && this.announced !== status.latest.version) {
      this.announced = status.latest.version;
      this.bus.publish({ type: "update-available", status });
    }
    return status;
  }

  private githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "dispatch-update-check",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = this.env.GITHUB_TOKEN ?? this.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.etag) headers["If-None-Match"] = this.etag;
    return headers;
  }

  /** The GitHub path this channel's head comes from — one page, or none at all. */
  private headPath(): string {
    return this.channel === "unstable"
      ? `repos/${this.repo}/releases?per_page=${UNSTABLE_PAGE_SIZE}`
      : `repos/${this.repo}/releases/latest`;
  }

  /**
   * Pick the channel head out of whatever GitHub answered.
   *
   * Stable gets an object back and GitHub has already done the filtering.
   * Unstable gets an array and has to order it here — by build stamp, not by the
   * array's own order, because `created_at` order and version order come apart
   * the moment two releases are cut in the same second or a tag is re-pushed.
   * Anything unorderable (a semver tag) is skipped rather than guessed at, the
   * same call `compareBuildVersions` documents.
   */
  private pickHead(payload: unknown): LatestRelease | null {
    if (this.channel !== "unstable") return toLatest(payload as RawRelease);
    if (!Array.isArray(payload)) return null;
    let best: LatestRelease | null = null;
    for (const raw of payload as RawRelease[]) {
      const candidate = toLatest(raw, true);
      if (!candidate) continue;
      // Skip the unorderable BEFORE it can become `best`. Without this, a semver
      // tag high in the list wins by default and then never loses, because every
      // later comparison against it answers `null` rather than `-1`.
      if (compareBuildVersions(candidate.version, candidate.version) === null) continue;
      if (!best || compareBuildVersions(best.version, candidate.version) === -1) {
        best = candidate;
      }
    }
    return best;
  }

  /** Resolve the newest release, or the sentinel `"not-modified"` on a 304. */
  private async fetchLatest(): Promise<LatestRelease | null | "not-modified"> {
    const url = `https://api.github.com/${this.headPath()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: this.githubHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Offline / DNS / timeout. `gh` would fail the same way, so don't spend a
      // subprocess proving it.
      throw new Error(`update check could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 304) return "not-modified";

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      // Private repo with no token in the server's environment, or the
      // anonymous hourly quota is spent. `gh` carries the user's own creds.
      return this.fetchLatestViaGh(response.status);
    }

    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release`);

    this.etag = response.headers.get("etag") ?? undefined;
    return this.pickHead(await response.json());
  }

  private async fetchLatestViaGh(httpStatus: number): Promise<LatestRelease | null> {
    try {
      const { stdout } = await this.execImpl("gh", [
        "api",
        this.headPath(),
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ]);
      // A gh answer has no ETag we can reuse; drop the stale one so the next
      // HTTP attempt asks for the full body instead of a misleading 304.
      this.etag = undefined;
      return this.pickHead(JSON.parse(stdout));
    } catch (err) {
      throw new Error(
        `GitHub answered ${httpStatus} and the gh CLI fallback failed ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Set GITHUB_TOKEN or run \`gh auth login\` to check for updates.`,
      );
    }
  }
}
