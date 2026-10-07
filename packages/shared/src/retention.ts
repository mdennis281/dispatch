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
 *  - `reviewerChatDays` / `toolImageDays` / `chatDeleteDays` are DELETION
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
});
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

/**
 * The project-level block (`project.yaml` → `retention`).
 *
 * ONLY the load cap. A repo with 874 chats wants a different number on screen
 * than one with ten, and that is a per-repo fact. The deletion windows are
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
});
export type ProjectRetention = z.infer<typeof ProjectRetentionSchema>;

/** Everything resolved, each value still able to say which layer it came from. */
export interface ResolvedRetention {
  /** Chats loaded per project; `0` means unlimited. */
  maxChatsPerProject: Layered<number>;
  reviewerChatDays: Layered<number>;
  toolImageDays: Layered<number>;
  chatDeleteDays: Layered<number>;
  /** The three windows in ms, for the sweep. `chatDeleteMs` is 0 when off. */
  reviewerChatMs: number;
  toolImageMs: number;
  chatDeleteMs: number;
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
  const chatDeleteDays = layer(undefined, app?.chatDeleteDays, DEFAULT_CHAT_DELETE_DAYS);

  return {
    maxChatsPerProject,
    reviewerChatDays,
    toolImageDays,
    chatDeleteDays,
    reviewerChatMs: reviewerChatDays.effective * DAY_MS,
    toolImageMs: toolImageDays.effective * DAY_MS,
    chatDeleteMs: chatDeleteDays.effective * DAY_MS,
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
