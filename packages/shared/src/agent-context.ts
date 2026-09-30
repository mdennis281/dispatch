/**
 * AGENT CONTEXT — what Dispatch puts in front of an agent before it reads a
 * word of the task, and the knobs that bound it.
 *
 * Two things landed in every turn with no owner and no control surface:
 *
 *  - HOUSE RULES, capped at a constant nobody could see or move. The cap was
 *    right to exist (it replaced a 4KB tier that silently truncated whatever
 *    sorted last) but wrong to be invisible: a project whose always-on guidance
 *    genuinely runs to a few thousand characters had no move except to smuggle
 *    it back in as an instruction file — which is the tier the cap existed to
 *    kill, re-entered through the side door.
 *  - MEMORY SURFACING, tuned by module constants in `memory.ts` calibrated
 *    against one 141-memory store. A project with 20 memories and one with 800
 *    got the same six-per-turn budget.
 *
 * So both become settings with the same shape: an app-level value that is the
 * install's answer, and an optional project override for the repo that needs a
 * different one. `resolveAgentContext` is the ONLY place that chain is walked —
 * the broker, the house-rules writer and the settings panes all call it, so
 * "what is actually in force" has one answer rather than four inline `??`s.
 *
 * The ceilings here are not style. Every char in this budget is paid on every
 * turn of every chat forever, so the settings are bounded rather than free: a
 * field you can type 200000 into is a way to make a project permanently
 * expensive by accident.
 */
import * as z from "zod";
import { resolveLayered, type Layered } from "./layered.js";

/* ------------------------------------------------------------- house rules */

/**
 * Default cap (chars) on ONE house-rules file, and the value every install
 * starts at.
 *
 * Deliberately unchanged from the constant it replaces: raising the default
 * would quietly re-inflate what always-on costs for every existing project,
 * which is the opposite of the point. Moving it is now a choice someone makes
 * in Settings, sees the size of, and can undo.
 */
export const DEFAULT_HOUSE_RULES_LIMIT = 1000;

/**
 * The most a house-rules file may EVER be allowed to grow to, whatever the
 * setting says.
 *
 * 8000 chars ≈ 2000 tokens per scope, so both scopes at the ceiling is ~4000
 * tokens spent before the conversation starts. That is already a lot; past it
 * you do not want house rules, you want a skill that loads when it is relevant.
 */
export const HOUSE_RULES_LIMIT_CEILING = 8000;

/**
 * What a project's house rules do to the machine-wide ones.
 *
 * - `append` — global first, then the project's. The default, and what the
 *   injection has always done: broad rules, then the repo's specifics.
 * - `replace` — this project's rules INSTEAD of the global ones. For a repo
 *   whose way of working genuinely contradicts the machine default, where
 *   appending would ship the agent two rules that disagree and let it pick.
 */
export const HouseRulesModeSchema = z.enum(["append", "replace"]);
export type HouseRulesMode = z.infer<typeof HouseRulesModeSchema>;

export const DEFAULT_HOUSE_RULES_MODE: HouseRulesMode = "append";

/* ---------------------------------------------------------------- memory */

/** Most memories referenced in one turn's surfaced block, across both tiers. */
export const DEFAULT_MEMORY_SURFACE_LIMIT = 6;
/** Most memories per turn that arrive as a FULL body rather than a pointer. */
export const DEFAULT_MEMORY_FULL_LIMIT = 2;
/** Total chars one turn's surfaced block may spend (bodies + pointer lines). */
export const DEFAULT_MEMORY_CHAR_BUDGET = 3200;

/** Ceilings, for the same reason the house-rules one exists. */
export const MEMORY_SURFACE_LIMIT_CEILING = 24;
export const MEMORY_FULL_LIMIT_CEILING = 12;
export const MEMORY_CHAR_BUDGET_CEILING = 20000;

/**
 * How much durable memory rides on a turn. Every field optional: absent means
 * "inherit", which for the app layer means the DEFAULT_* above.
 */
export const MemoryInjectionSettingsSchema = z.object({
  /** Memories named in one turn, full bodies and pointers together. */
  surfaceLimit: z.number().int().positive().max(MEMORY_SURFACE_LIMIT_CEILING).optional(),
  /** How many of those arrive whole. Clamped to `surfaceLimit` on resolve. */
  fullLimit: z.number().int().nonnegative().max(MEMORY_FULL_LIMIT_CEILING).optional(),
  /** Chars the whole block may spend. */
  charBudget: z.number().int().positive().max(MEMORY_CHAR_BUDGET_CEILING).optional(),
});
export type MemoryInjectionSettings = z.infer<typeof MemoryInjectionSettingsSchema>;

/* --------------------------------------------------------------- settings */

/** The app-level block (`config.json` → `agentContext`). */
export const AgentContextSettingsSchema = z.object({
  /**
   * Cap on each house-rules file. Optional rather than defaulted so a cleared
   * field falls back to {@link DEFAULT_HOUSE_RULES_LIMIT} instead of being
   * pinned to whatever the default was on the day it was written.
   */
  houseRulesLimit: z.number().int().positive().max(HOUSE_RULES_LIMIT_CEILING).optional(),
  memory: MemoryInjectionSettingsSchema.optional(),
});
export type AgentContextSettings = z.infer<typeof AgentContextSettingsSchema>;

/**
 * The project-level block (`project.yaml` → `agentContext`). Everything the app
 * block has, plus the one question only a repo can answer: whether its house
 * rules sit alongside the machine's or stand in for them.
 */
export const ProjectAgentContextSchema = AgentContextSettingsSchema.extend({
  houseRulesMode: HouseRulesModeSchema.optional(),
});
export type ProjectAgentContext = z.infer<typeof ProjectAgentContextSchema>;

/** Everything resolved, with each value still able to say where it came from. */
export interface ResolvedAgentContext {
  houseRulesLimit: Layered<number>;
  houseRulesMode: Layered<HouseRulesMode>;
  memory: {
    surfaceLimit: Layered<number>;
    fullLimit: Layered<number>;
    charBudget: Layered<number>;
  };
}

/**
 * Walk project → app → default for every agent-context knob.
 *
 * Two layers, not three: none of this is per-chat. House rules are the thing
 * that applies to EVERY chat by definition, and a per-chat memory budget would
 * make "why did that fact not surface" unanswerable without opening the chat's
 * own row. `resolveLayered` is still the vehicle so the panes get the same
 * `source`/`inherited` reporting every other layered setting has.
 */
export function resolveAgentContext(
  app: AgentContextSettings | undefined | null,
  project: ProjectAgentContext | undefined | null,
): ResolvedAgentContext {
  const layer = <T>(p: T | undefined, a: T | undefined, fallback: T) =>
    resolveLayered<T>({ project: p, app: a }, fallback);

  const surfaceLimit = layer(
    project?.memory?.surfaceLimit,
    app?.memory?.surfaceLimit,
    DEFAULT_MEMORY_SURFACE_LIMIT,
  );
  const fullLimit = layer(
    project?.memory?.fullLimit,
    app?.memory?.fullLimit,
    DEFAULT_MEMORY_FULL_LIMIT,
  );

  return {
    houseRulesLimit: layer(
      project?.houseRulesLimit,
      app?.houseRulesLimit,
      DEFAULT_HOUSE_RULES_LIMIT,
    ),
    houseRulesMode: layer(project?.houseRulesMode, undefined, DEFAULT_HOUSE_RULES_MODE),
    memory: {
      surfaceLimit,
      // A full-body budget above the total is not a bigger budget, it is a
      // contradiction — the surfacer would promise more whole bodies than it is
      // allowed to name at all. Clamp rather than reject: these arrive from two
      // independently-edited layers, so the invalid pair is reachable without
      // anyone typing anything invalid.
      fullLimit: {
        ...fullLimit,
        effective: Math.min(fullLimit.effective, surfaceLimit.effective),
      },
      charBudget: layer(
        project?.memory?.charBudget,
        app?.memory?.charBudget,
        DEFAULT_MEMORY_CHAR_BUDGET,
      ),
    },
  };
}
