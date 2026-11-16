/**
 * RETENTION — how much of an install's history Dispatch LOADS, and how long it
 * KEEPS. Two different questions, deliberately in one block because they are
 * the two halves of "I have too many chats".
 *
 * The distinction is the whole design, so it is worth being blunt about:
 *
 *  - {@link ResolvedRetention.maxChatsPerProject} is a LOAD cap. Nothing is
 *    deleted, nothing is modified on disk. It bounds what `GET /api/chats`
 *    ships and therefore what the client holds; everything past it stays on
 *    disk, stays searchable through `chat_find`, and comes back on request.
 *  - `reviewerChatDays` / `toolImageDays` / `artifactDays` / `chatDeleteDays` are DELETION
 *    windows, enforced by the server's retention sweep.
 *
 * Why a load cap is the primary answer rather than a count-based deletion
 * policy: measured on the install this was built for, 1621 chats over 92 days,
 * the busiest project held 874 of them. A flat cap of 200 per project puts its
 * cutoff at chats **2.8 days old** — so a count cap tuned to make the sidebar
 * readable, if it deleted, would be destroying this week's work, while the same
 * number on a quiet project reaches back two months. A count is the right knob
 * for "how much do I want on screen" and the wrong one for "what may be thrown
 * away"; age is the right knob for the second, and the two are now separate
 * fields instead of one number doing both jobs badly.
 *
 * These were module constants in `services/retention.ts`, whose docblock argued
 * that "none of these is a thing anyone should have to tune, and a setting is a
 * promise to support every value of it". The second half of that is still true
 * and is why every field here is bounded — but the first half did not survive
 * contact with an install big enough to need them: the windows that decide how
 * much disk a year of work costs turned out to be exactly what someone wants to
 * move, and moving them meant editing this file.
 */
import * as z from "zod";
import { resolveLayered, type Layered } from "./layered.js";

const DAY_MS = 24 * 60 * 60_000;

/* -------------------------------------------------------------- load cap */

/**
 * Chats loaded per project, newest activity first. The install's starting
 * answer and the number the feature was specified at.
 */
export const DEFAULT_MAX_CHATS_PER_PROJECT = 200;

/**
 * The most a project may load however high the setting goes.
 *
 * Not arbitrary: the hydrate is ONE unscoped `GET /api/chats` into one client
 * store, so this number multiplied by the project count is the payload and the
 * resident set. 2000 is comfortably past any real sidebar and still bounded.
 */
export const MAX_CHATS_PER_PROJECT_CEILING = 2000;

/** `maxChatsPerProject: 0` — load every chat, the behaviour before this setting. */
export const CHATS_PER_PROJECT_UNLIMITED = 0;

/* ------------------------------------------------------- deletion windows */

/** Days a reviewer chat outlives its PR's merge or close. */
export const DEFAULT_REVIEWER_CHAT_DAYS = 14;

/**
 * Days a TOOL-OUTPUT image outlives the turn that produced it.
 *
 * Mirrors `TOOL_IMAGE_RETENTION_DAYS` in `media-index.ts`, which stays where it
 * is because the client's "image expired" placeholder reads it to state the
 * same number the sweep enforces. That constant is now the DEFAULT for this
 * setting rather than the enforced value — see {@link resolveRetention}.
 */
export const DEFAULT_TOOL_IMAGE_DAYS = 30;

/**
 * Days an ARTIFACT outlives its last edit. Shorter than a tool image on
 * purpose: an artifact is a working view — the page the agent built to show
 * you something this week — and the thing it depicts usually lives on in the
 * repo. Text, too, so even a busy install's week of them costs less disk than
 * one screen recording.
 */
export const DEFAULT_ARTIFACT_DAYS = 7;

/**
 * Days an idle chat may sit before the sweep deletes it outright. `0` is OFF,
 * and is the default.
 *
 * Off by default on purpose. Every other field here changes how much is shown
 * or how long a DERIVED artefact lives — a reviewer chat whose findings are on
 * GitHub, a tool screenshot. This one deletes the conversation itself, and
 * `messages.jsonl` is the only copy once Claude Code's own session cleanup has
 * run. A setting that starts deleting transcripts the moment an install
 * upgrades into it is not a default anyone consented to.
 */
export const DEFAULT_CHAT_DELETE_DAYS = 0;

/**
 * Floor on a non-zero {@link DEFAULT_CHAT_DELETE_DAYS}.
 *
 * Validated rather than clamped: a typed `3` silently becoming `7` is a setting
 * lying about what it will do, and what it will do is irreversible. 7 days is
 * the shortest window in which "that chat from last week" is not a routine
 * thing to say.
 */
export const CHAT_DELETE_DAYS_MINIMUM = 7;

/** Ceiling shared by the three day-windows — two years, past which it is "never". */
export const RETENTION_DAYS_CEILING = 730;

/* ------------------------------------------------- browser artifact cache */

/**
 * Megabytes of artifact content and asset blobs ONE browser keeps in IndexedDB
 * so an artifact opens without downloading it again (`lib/artifactCache.ts`).
 *
 * A client-side budget, not a server one: it bounds what this origin holds on
 * this device, and the server's `artifactDays` window still decides how long an
 * artifact exists at all. 500 MB holds a busy week of pages plus a couple of
 * asset-heavy games; a phone that wants less can be told so per project.
 * `0` turns the cache off — every open downloads, as before it existed.
 */
export const DEFAULT_ARTIFACT_CACHE_MB = 500;

/**
 * Largest asset bundle the PRELOADER fetches ahead of time, in MB. Content (the
 * page itself, ≤ 8 MB) is always preloaded; assets are the expensive part —
 * a version may carry 256 MB of them — and fetching that for every edit an
 * agent makes in a project you are not even looking at would eat a metered
 * connection. `0` preloads content only.
 */
export const DEFAULT_ARTIFACT_PRELOAD_MB = 32;

/** 20 GB — past any sane browser quota, so a typo cannot ask for terabytes. */
export const ARTIFACT_CACHE_MB_CEILING = 20_000;
/** A bundle can't exceed `ARTIFACT_ASSETS_MAX_BYTES` (256 MB), so neither can its preload cap. */
export const ARTIFACT_PRELOAD_MB_CEILING = 256;

const MB = 1024 * 1024;

const artifactCacheMb = z.number().int().nonnegative().max(ARTIFACT_CACHE_MB_CEILING);
const artifactPreloadMb = z.number().int().nonnegative().max(ARTIFACT_PRELOAD_MB_CEILING);

/* -------------------------------------------------------------- settings */

/**
 * The app-level block (`config.json` → `retention`).
 *
 * Every field optional, none with an inner `.default()`: unset means "inherit
 * the shipped default", and materialising the effective value into the stored
 * object would pin the install to today's numbers the first time anyone saves
 * anything — the trap the project-level `maxRounds` was in before PR #314.
 */
export const RetentionSettingsSchema = z.object({
  /** Load cap. `0` = unlimited. See {@link DEFAULT_MAX_CHATS_PER_PROJECT}. */
  maxChatsPerProject: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CHATS_PER_PROJECT_CEILING)
    .optional(),
  reviewerChatDays: z.number().int().positive().max(RETENTION_DAYS_CEILING).optional(),
  toolImageDays: z.number().int().positive().max(RETENTION_DAYS_CEILING).optional(),
  artifactDays: z.number().int().positive().max(RETENTION_DAYS_CEILING).optional(),
  /** `0` = never delete a chat by age. Otherwise at least {@link CHAT_DELETE_DAYS_MINIMUM}. */
  chatDeleteDays: z
    .number()
    .int()
    .nonnegative()
    .max(RETENTION_DAYS_CEILING)
    .refine((v) => v === 0 || v >= CHAT_DELETE_DAYS_MINIMUM, {
      message: `Use 0 for "never", or at least ${CHAT_DELETE_DAYS_MINIMUM} days — a shorter window deletes conversations you are still working through.`,
    })
    .optional(),
  /** Browser artifact cache budget, MB. `0` = off. See {@link DEFAULT_ARTIFACT_CACHE_MB}. */
  artifactCacheMb: artifactCacheMb.optional(),
  /** Largest asset bundle preloaded, MB. `0` = content only. See {@link DEFAULT_ARTIFACT_PRELOAD_MB}. */
  artifactPreloadMb: artifactPreloadMb.optional(),
});
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

/**
 * The project-level block (`project.yaml` → `retention`).
 *
 * The load cap and the two browser-cache budgets. A repo with 874 chats wants
 * a different number on screen than one with ten, and a repo whose agents ship
 * 200 MB WebGL builds wants a different cache than one that draws SVGs — both
 * per-repo facts. Neither deletes anything on the server: the cache budgets
 * only decide what a browser keeps a COPY of, and both are bounded, so the
 * worst a manifest can do is ask a device to cache up to its ceiling. The deletion windows are
 * deliberately not overridable: they are a statement about how much disk this
 * MACHINE spends on history, and letting a manifest — a file an agent can
 * write — shorten the window on the only copy of a transcript is not a knob
 * worth having.
 */
export const ProjectRetentionSchema = z.object({
  maxChatsPerProject: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CHATS_PER_PROJECT_CEILING)
    .optional(),
  /**
   * THIS project's share of the browser cache, MB. The app value is the
   * device's TOTAL budget and is always enforced too, so an override can only
   * narrow what this project keeps, never grow the cache past the app cap.
   */
  artifactCacheMb: artifactCacheMb.optional(),
  artifactPreloadMb: artifactPreloadMb.optional(),
});
export type ProjectRetention = z.infer<typeof ProjectRetentionSchema>;

/** Everything resolved, each value still able to say which layer it came from. */
export interface ResolvedRetention {
  /** Chats loaded per project; `0` means unlimited. */
  maxChatsPerProject: Layered<number>;
  reviewerChatDays: Layered<number>;
  toolImageDays: Layered<number>;
  artifactDays: Layered<number>;
  chatDeleteDays: Layered<number>;
  artifactCacheMb: Layered<number>;
  artifactPreloadMb: Layered<number>;
  /** The three windows in ms, for the sweep. `chatDeleteMs` is 0 when off. */
  reviewerChatMs: number;
  toolImageMs: number;
  artifactMs: number;
  chatDeleteMs: number;
  /** The two cache budgets in bytes, for `lib/artifactCache.ts`. 0 = off. */
  artifactCacheMaxBytes: number;
  artifactPreloadMaxBytes: number;
}

/**
 * Walk project → app → default. The ONE place the chain is walked, so "what is
 * actually in force" has a single answer rather than an inline `??` per caller
 * — the chats route, the sweep and the settings pane all come through here.
 */
export function resolveRetention(
  app: RetentionSettings | undefined | null,
  project?: ProjectRetention | undefined | null,
): ResolvedRetention {
  const layer = <T>(p: T | undefined, a: T | undefined, fallback: T) =>
    resolveLayered<T>({ project: p, app: a }, fallback);

  const maxChatsPerProject = layer(
    project?.maxChatsPerProject,
    app?.maxChatsPerProject,
    DEFAULT_MAX_CHATS_PER_PROJECT,
  );
  // `undefined` for the project layer rather than omitting the call: these three
  // have no project layer BY DESIGN (see ProjectRetentionSchema), and routing
  // them through the same resolver keeps the `source`/`inherited` reporting the
  // settings pane reads uniform across all four fields.
  const reviewerChatDays = layer(undefined, app?.reviewerChatDays, DEFAULT_REVIEWER_CHAT_DAYS);
  const toolImageDays = layer(undefined, app?.toolImageDays, DEFAULT_TOOL_IMAGE_DAYS);
  const artifactDays = layer(undefined, app?.artifactDays, DEFAULT_ARTIFACT_DAYS);
  const chatDeleteDays = layer(undefined, app?.chatDeleteDays, DEFAULT_CHAT_DELETE_DAYS);
  const artifactCacheMb = layer(project?.artifactCacheMb, app?.artifactCacheMb, DEFAULT_ARTIFACT_CACHE_MB);
  const artifactPreloadMb = layer(
    project?.artifactPreloadMb,
    app?.artifactPreloadMb,
    DEFAULT_ARTIFACT_PRELOAD_MB,
  );

  return {
    maxChatsPerProject,
    reviewerChatDays,
    toolImageDays,
    artifactDays,
    chatDeleteDays,
    artifactCacheMb,
    artifactPreloadMb,
    reviewerChatMs: reviewerChatDays.effective * DAY_MS,
    toolImageMs: toolImageDays.effective * DAY_MS,
    artifactMs: artifactDays.effective * DAY_MS,
    chatDeleteMs: chatDeleteDays.effective * DAY_MS,
    artifactCacheMaxBytes: artifactCacheMb.effective * MB,
    artifactPreloadMaxBytes: artifactPreloadMb.effective * MB,
  };
}

/**
 * Keep the newest `limit` chats per project, plus every PINNED chat whatever
 * its age.
 *
 * Shared rather than inlined in the route because the client needs the same
 * rule to decide whether a project has more to fetch, and two implementations
 * of "which 200" would disagree the first time either moved.
 *
 * **Pinning is not a nicety.** The cap orders by last activity, and a chat can
 * be live without being recent in that ordering for the moment between its
 * session starting and its first row landing — and a chat waiting on a
 * permission prompt from four hours ago is both old and the single most
 * important row on the screen. Dropping either from the payload hides a chat
 * that is actively asking for something, and the UI has no way to know it is
 * missing. So the caller passes everything the server knows is live and those
 * ride along above the cap.
 *
 * Parent edges are deliberately NOT walked here. `buildChatTree` resolves a
 * parent through its `present` set and draws a child whose parent was capped
 * out as a root, which is honest — the row is still there, just not nested.
 * Pulling ancestors in would mean reproducing both nesting edges (and the PR
 * catalog one of them goes through) on a path whose whole job is to be cheap.
 */
export function capChatsPerProject<T extends { id: string; projectId: string }>(
  chats: readonly T[],
  /**
   * The cap, or a function of the project id when projects may differ — a repo
   * can set its own in `project.yaml`. A per-project function rather than one
   * number because the unscoped hydrate caps EVERY project in one call, so a
   * single limit would silently apply one project's override to all of them.
   */
  limit: number | ((projectId: string) => number),
  opts: { pinned?: ReadonlySet<string>; activityOf: (chat: T) => number },
): T[] {
  const limitFor = typeof limit === "function" ? limit : () => limit;
  const pinned = opts.pinned ?? new Set<string>();
  const byProject = new Map<string, T[]>();
  for (const chat of chats) {
    const list = byProject.get(chat.projectId);
    if (list) list.push(chat);
    else byProject.set(chat.projectId, [chat]);
  }
  const kept: T[] = [];
  for (const [projectId, list] of byProject) {
    const projectLimit = limitFor(projectId);
    if (projectLimit <= CHATS_PER_PROJECT_UNLIMITED) {
      for (const chat of list) kept.push(chat);
      continue;
    }
    // Newest first. Pinned rows are counted against the cap rather than added
    // on top of it: they are the rows you most want loaded, so they belong
    // inside the budget, and a project whose every chat is pinned should load
    // its cap's worth rather than all of them.
    const ranked = [...list].sort((a, b) => {
      const byPin = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
      return byPin !== 0 ? byPin : opts.activityOf(b) - opts.activityOf(a);
    });
    for (const chat of ranked.slice(0, projectLimit)) kept.push(chat);
  }
  return kept;
}
