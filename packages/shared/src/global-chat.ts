/**
 * THE GLOBAL CHAT — one chat that belongs to no repo.
 *
 * Every other chat in Dispatch is anchored to a project: it has a checkout to
 * work in, a workflow contract, a memory store, a sidebar. That anchoring is
 * load-bearing (`stores/navigation.ts` holds the invariant that the open chat
 * belongs to the focused project), and it is also the thing in the way when
 * what you want is a chat that can SEE ACROSS the install — "which project was
 * that MCP in", "find the chat where we argued about the release channel",
 * "start the work in the-salesman from here".
 *
 * WHY A RESERVED PSEUDO-PROJECT rather than a nullable `Chat.projectId`.
 * Making the id optional is a change every consumer pays for: a hundred-odd
 * `projects.find(p => p.id === chat.projectId)` sites, the navigation
 * invariant, the sidebar, metrics facets, the store's path builder. Each one
 * would need a "no project" branch, and the ones that were forgotten would
 * fail at runtime in the mixed-scope way that invariant exists to prevent.
 *
 * A RESERVED ID satisfies all of them unchanged — it is a real `Project`
 * record with a real (if empty) directory, so navigation, the chat list and
 * the transcript work with no new branch anywhere. The cost moves to one
 * specific, enumerable place: anywhere a list of projects is offered to a
 * human as a repo to act on, this one must be filtered out. {@link realProjects}
 * is that filter, and the call sites are listed in its doc comment so the next
 * picker added is a grep away from knowing it needs one.
 *
 * WHY THE AUTHORITY IS A MODE. "Can see everything, can start work, cannot
 * land anything" is a permission posture, and Dispatch already has exactly one
 * mechanism for those — see {@link GLOBAL_MODE}. Expressing it as bespoke
 * `if (isGlobalProject(...))` branches inside tool handlers would scatter the
 * rule across every handler and leave the next tool ungated by default.
 */
import type { ModeConfig, Project } from "./domain.js";
import type { PostureLayers, PostureProject } from "./chat-posture.js";

/* ----------------------------------------------------------- the pseudo-project */

/**
 * The reserved project id the global chat lives under.
 *
 * Double-underscored so it cannot collide with a slug any real project would
 * be given, and still inside the store's entity-id allowlist
 * (`/^[A-Za-z0-9_-]{1,64}$/`) because it becomes a path segment for the chat
 * directory and the global memory store.
 */
export const GLOBAL_PROJECT_ID = "__global__";

/** What the pseudo-project is called wherever it IS shown. */
export const GLOBAL_PROJECT_NAME = "Global";

/** Is this the reserved pseudo-project? */
export function isGlobalProject(projectId: string | null | undefined): boolean {
  return projectId === GLOBAL_PROJECT_ID;
}

/**
 * Drop the pseudo-project from a list of projects.
 *
 * Apply this wherever a list is offered as "a repo you can act on". The sites,
 * so a future one can be checked against the list rather than rediscovered:
 *
 *   client  — the sidebar's project selector, the command palette's project
 *             rows, Settings → Chat's per-project defaults, the Agents & modes
 *             dialog's scope picker, the growth-metrics project facet and the
 *             metrics project labels, and `initialProject` (which would
 *             otherwise open a fresh browser on the global project whenever it
 *             sorted first).
 *   server  — `GET /api/projects` keeps it (the client needs the record to
 *             render the chat at all), but the repo-walking services skip it:
 *             the worktree detector, the PR registry and trunk sync all take
 *             `realProjects` because it has no git repo to walk.
 *
 * Deliberately NOT applied to `.find(p => p.id === chat.projectId)` lookups —
 * those WANT the record, and getting it is the entire reason this is a project
 * rather than a null.
 */
export function realProjects<T extends { id: string }>(projects: readonly T[]): T[] {
  return projects.filter((p) => !isGlobalProject(p.id));
}

/**
 * The pseudo-project record, synthesized rather than stored.
 *
 * Nothing writes this to `projects/`, and the store refuses an attempt — so
 * there is no migration to run on an existing install, no row to go stale
 * against a later change here, and no way for the record that grants a chat
 * its cross-project posture to be edited into something else.
 *
 * `repoPath` is a real directory (created on demand) but NOT a git repo, and
 * that is deliberate on two counts: `inspectCwd` reports no branch, so the
 * workflow guard has no trunk to protect and says nothing; and a shell that
 * somehow got through would find itself nowhere useful. `workflow.profile` is
 * `none` for the same reason — there is nothing here to ship.
 */
export function globalProject(repoPath: string, createdAt = 0): Project {
  return {
    id: GLOBAL_PROJECT_ID,
    name: GLOBAL_PROJECT_NAME,
    repoPath,
    worktreeRoot: repoPath,
    workflow: { profile: "none" },
    subApps: [],
    createdAt,
  };
}

/* ------------------------------------------------------------------- the mode */

/** The id of the posture a global chat runs under. */
export const GLOBAL_MODE_ID = "global";

/**
 * Tools a global chat may not call.
 *
 * A DENY list rather than an allow list, chosen with eyes open. An allow list
 * is the safer default for a hostile caller, but this caller is the human's own
 * agent and the surface it legitimately needs — every read tool, every search,
 * every `dispatch-*` observation tool, web access — grows with the product. An
 * allow list would silently strip each new one until someone noticed, which is
 * how a posture becomes a thing people turn off.
 *
 * So the list names what landing a change actually REQUIRES, and the first
 * entries are the ones that matter most:
 *
 *   - THE SHELLS COME FIRST. Denying `Edit` while allowing `Bash` is theatre —
 *     `sed -i`, `git worktree add` and `gh pr merge` are each one command. Any
 *     tool that can put a string on a shell is denied, Dispatch's own tracked
 *     terminal included (for the same reason `shell-guard` includes it: leaving
 *     out the path every agent is told to prefer makes the guard a formality).
 *   - THEN THE WRITE TOOLS, so the model gets a clear refusal rather than a
 *     mysterious permission prompt.
 *   - THEN THE TOOLS THAT MOVE A PULL REQUEST. `watch_pr` is deliberately
 *     absent: watching is observation, and a global chat that can see a
 *     spawned chat's PR go green is more useful and lands nothing.
 *   - THEN THE CONFIG WRITERS, because `.dispatch/` is committed files in
 *     somebody's repo — editing a skill is editing code with extra steps.
 *
 * `mcp__dispatch-memory__remember` is NOT here. Memory is Dispatch's own store
 * rather than a repo, recording is additive, and a cross-project chat that
 * cannot write down what it just learned across five projects is the one that
 * most needed to. `forget` IS denied: it destroys.
 */
export const GLOBAL_MODE_DISALLOWED_TOOLS: readonly string[] = [
  // shells — the complete bypass of everything below
  "Bash",
  "PowerShell",
  "mcp__dispatch-workspace__terminal",
  "mcp__dispatch-workspace__run_subapp",
  // code edits
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  // worktrees
  "mcp__dispatch-workspace__worktree",
  // landing a change
  "mcp__dispatch-github__create_pr",
  "mcp__dispatch-github__approve_pr",
  "mcp__dispatch-github__post_review",
  "mcp__dispatch-github__request_review",
  "mcp__dispatch-github__resolve_thread",
  // committed config in somebody's repo
  "mcp__dispatch-config__config_write",
  "mcp__dispatch-config__config_delete",
  "mcp__dispatch-config__mode_write",
  "mcp__dispatch-config__mode_delete",
  "mcp__dispatch-mcp__mcp_add",
  "mcp__dispatch-mcp__mcp_remove",
  // destructive
  "mcp__dispatch-memory__forget",
];

/** The overlay a global chat reads, so the refusals are never a surprise. */
export const GLOBAL_MODE_INSTRUCTIONS = `You are the GLOBAL chat. You belong to no project: there is no checkout here, no branch, and no worktree.

What you are for: holding the view across every project on this install. Answering "where does that live", "what is running where", "which chat decided that" — and then starting the work in the project that owns it.

**You may** read and search anything (\`Read\`, \`Grep\`, \`Glob\`, the web), inspect any project (\`mcp__dispatch-project__project_list\`, \`project_info\`), search and read any chat (\`mcp__dispatch-chat__chat_find\`, \`chat_read\`), read memory and metrics, watch a pull request, and **spawn a chat into any project** with \`mcp__dispatch-chat__spawn_chat({ projectId, prompt })\`.

**You may not** run a shell, edit a file, cut a worktree, open or land a pull request, or write committed \`.dispatch/\` config. Those calls are refused, not prompted. This is not a limitation to work around — it is the point: work that touches a repo happens in a chat that has one.

So when a task needs code changed, do not try to do it. Scope it, then \`spawn_chat\` it into the owning project with a brief that carries everything you learned. Report back what you spawned.`;

/**
 * The posture, as a built-in mode.
 *
 * `default` rather than `plan` for the permission mode, even though "look,
 * don't touch" is what `plan` is named for. Plan mode's actual behaviour is to
 * make the agent produce a plan and then ask to LEAVE — which is the wrong
 * shape for a chat whose steady state is answering questions, and which would
 * hand it an `ExitPlanMode` escape hatch to rattle. Under `default` every tool
 * that could change anything is already refused by {@link
 * GLOBAL_MODE_DISALLOWED_TOOLS} before a prompt could be raised, so the only
 * calls left are reads — which `default` allows without asking.
 *
 * Built-in (scope `global`, no file) rather than seeded into the store: a
 * seeded row can be edited or deleted, and a global chat whose posture someone
 * cleared is a project-less chat with a shell.
 */
export const GLOBAL_MODE: ModeConfig = {
  id: GLOBAL_MODE_ID,
  name: "Global",
  description: "Cross-project overview: spawn and observe, never land.",
  permissionMode: "default",
  disallowedTools: [...GLOBAL_MODE_DISALLOWED_TOOLS],
  instructions: GLOBAL_MODE_INSTRUCTIONS,
  scope: "global",
};

/**
 * The project layer of the posture chain, with the pseudo-project stating its
 * own: a global chat runs in {@link GLOBAL_MODE} unless its own row pins
 * something, and `setMode` is what stops it pinning anything else.
 *
 * It arrives through the PROJECT layer rather than as a special case further
 * down because that is where "work in this repo starts like this" already
 * lives — and because three separate places build that layer (the broker at
 * session start, the create-chat route, and the client's badge). Routing all
 * three through one function is what stops the composer showing "Auto" while
 * the session actually runs as `global`, which is exactly what happened when
 * only the broker knew.
 */
export function projectPostureLayer(
  projectId: string | null | undefined,
  layer: PostureProject | null | undefined,
): PostureProject | null | undefined {
  return isGlobalProject(projectId) ? { ...(layer ?? {}), mode: GLOBAL_MODE_ID } : layer;
}

/**
 * The whole posture chain, with the global project's mode made unavoidable.
 *
 * {@link projectPostureLayer} alone is NOT enough, and the gap is the obvious
 * attack on it: the project layer sits BELOW the chat and parent layers, so
 * `POST /api/chats` (or `spawn_chat`) with
 * `{ projectId: "__global__", modeId: "yolo" }` resolved to `yolo` and came up
 * with a shell. `setMode` never got a look in — the chat was born that way.
 *
 * So a conflicting mode above the project layer is DROPPED rather than
 * rejected. Dropping keeps a spawn into the global project working when the
 * parent happens to be in some other mode (a rejection there would be a
 * confusing failure for a caller who never asked for a mode at all), and it
 * leaves the project layer to answer — so the UI's "inherited from" label
 * credits the layer that actually states the rule.
 */
export function enforceGlobalPosture(
  projectId: string | null | undefined,
  layers: PostureLayers,
): PostureLayers {
  const project = projectPostureLayer(projectId, layers.project);
  if (!isGlobalProject(projectId)) return { ...layers, project };
  return {
    ...layers,
    project,
    ...(layers.chat ? { chat: { ...layers.chat, modeId: undefined } } : {}),
    ...(layers.parent ? { parent: { ...layers.parent, modeId: undefined } } : {}),
  };
}

/* ---------------------------------------------------------- the always-on index */

/** The shape {@link buildGlobalProjectIndex} needs from a project. */
export interface GlobalIndexEntry {
  id: string;
  name: string;
  repoPath: string;
}

/**
 * The ONE block a global chat carries on every turn: project names, and where
 * they are. Nothing else.
 *
 * The temptation is to inject the overview — each project's workflow, subApps,
 * MCP servers, skills, recent chats — because that is what "a strong overview
 * of the project layout and the available MCPs" asks for. That version costs
 * roughly 150 tokens PER PROJECT, every turn, forever, and it grows each time
 * Michael onboards a repo. At twelve projects it is most of a page of standing
 * context to answer a question that might be about one of them.
 *
 * So the always-on tier is an INDEX — one line per project, ~12 tokens each,
 * enough to know what exists and to name it in a tool call — and the depth is
 * a tool: `project_list` for the layout across all of them, `project_info` for
 * one in full. The agent pays for detail when it needs detail. This is the
 * same trade the memory surfacer makes (pointers always, bodies on demand) and
 * the same one that keeps house rules capped.
 */
export function buildGlobalProjectIndex(projects: readonly GlobalIndexEntry[]): string {
  const rows = realProjects(projects)
    .map((p) => `- ${p.name} \`${p.id}\` — ${p.repoPath}`)
    .join("\n");
  return [
    "## Projects on this install",
    "",
    rows || "_No projects yet._",
    "",
    "That is the whole index — names and paths, nothing more. For a project's " +
      "workflow, sub-apps, MCP servers and skills call " +
      "`mcp__dispatch-project__project_list`; for one project in full, " +
      "`mcp__dispatch-project__project_info({ project })`. Spawn work with " +
      "`mcp__dispatch-chat__spawn_chat({ projectId, prompt })`.",
  ].join("\n");
}

/**
 * Is `tool` denied by this list?
 *
 * Exact names only — no globbing. A pattern language here would be a second
 * place to get a security rule subtly wrong, and every entry Dispatch needs to
 * deny is a name it already knows in full.
 */
export function isToolDenied(tool: string, disallowed: readonly string[] | undefined): boolean {
  return Boolean(disallowed?.includes(tool));
}

/**
 * What the agent is told when the selected mode refuses a call.
 *
 * Generic by default, because the broker applies mode denylists to EVERY mode
 * now, not just this one: a custom mode that denies one unrelated tool while
 * happily allowing edits must not be told it cannot change repositories.
 *
 * The global posture gets an extra paragraph, and it earns it. Without it the
 * model treats a refusal as an obstacle and goes looking for a way around —
 * which, in a chat where every route is closed, is a whole turn spent
 * rediscovering that. Naming `spawn_chat` turns the refusal into a redirect.
 */
export function deniedToolRefusal(tool: string, modeName: string, modeId?: string): string {
  const base =
    `\`${tool}\` is not available in ${modeName} mode — the mode's tool policy ` +
    `denies it. Another tool, a shell, or a subagent calling it on your behalf is ` +
    `refused the same way, so do not look for a route around it.`;
  if (modeId !== GLOBAL_MODE_ID) return base;
  return (
    `${base} This chat belongs to no project: it can read, search, inspect and ` +
    `spawn, but it cannot change a repository or land a change. If this task ` +
    `needs code changed, scope it and start it where it belongs with ` +
    `\`mcp__dispatch-chat__spawn_chat({ projectId, prompt })\`.`
  );
}

/**
 * The tool policy a mode imposes, resolved to a yes/no for one tool name.
 *
 * An allowlist is "only these", a denylist is "not these", and the denylist
 * wins — the same precedence `AgentConfig` has always had. An allowlist that
 * is DEFINED BUT EMPTY permits nothing, which is a real (if drastic) policy
 * and must not be confused with an absent one; `[]` and `undefined` differ
 * here on purpose, so neither this nor its callers may test it with `.length`.
 */
export function isToolAllowed(
  tool: string,
  policy: { allowedTools?: readonly string[]; disallowedTools?: readonly string[] } | undefined,
): boolean {
  if (!policy) return true;
  if (policy.allowedTools !== undefined && !policy.allowedTools.includes(tool)) return false;
  return !isToolDenied(tool, policy.disallowedTools);
}

/**
 * Built-in modes that are a full {@link ModeConfig} rather than just a
 * permission posture.
 *
 * The broker's `BUILTIN_MODE_PERMISSION` maps an id to a posture and nothing
 * else, which is all `plan`/`yolo`/… ever needed. A mode with an instruction
 * overlay and a tool denylist needs a record, and it needs to exist on an
 * install that has never written a mode file — so it lives here, shared by the
 * broker (which resolves it) and the `mode_*` tools (which must list it so an
 * agent can see the posture it is under).
 */
export const BUILTIN_MODE_CONFIGS: Record<string, ModeConfig> = {
  [GLOBAL_MODE_ID]: GLOBAL_MODE,
};

/**
 * Built-in modes that nothing may redefine — resolved BEFORE a project's
 * `.dispatch/modes/` and before the store, which is the opposite of the
 * normal precedence.
 *
 * The normal precedence (authored wins) is right for a mode that is a
 * convenience. It is wrong for one that is a SECURITY BOUNDARY: `global` is
 * writable at both of those layers today, so any project could ship a
 * `modes/global.yaml` with no denylist and every global chat on the install
 * would come up with a shell. Nobody would see it happen.
 */
export const PROTECTED_MODE_IDS: readonly string[] = [GLOBAL_MODE_ID];

/** True when `modeId` names a mode no project or store copy may shadow. */
export function isProtectedMode(modeId: string): boolean {
  return PROTECTED_MODE_IDS.includes(modeId);
}
