/**
 * agent-tasks — turn "I want an agent that audits our SQL migrations", or a
 * dirty working tree and a shrug, into a chat that actually does the work.
 *
 * Two halves, deliberately split:
 *
 *   - `@dispatch/shared/agent-tasks` holds what the LAUNCHER needs (labels,
 *     placeholders, default effort, extra toggles), because the client renders
 *     one form for every task from that catalog.
 *   - this file holds the BRIEFING, because briefings need the truth of the
 *     machine: the manifest can rename every config dir, and a commit sweep has
 *     to be told which repo (a worktree, usually not the checkout) and what is
 *     actually dirty in it.
 *
 * Briefings exist because the bare ask doesn't work. "Add an agent for X" puts a
 * file in the wrong directory with invented frontmatter; "commit my changes in
 * groups" produces `git add -A` and one commit called "updates". So each task
 * states where things go, what shape they take, and the house rules — composed
 * server-side, every time, rather than trusted to the model's memory of this
 * repo.
 *
 * The result is an ordinary chat with the project's normal tools, modes and
 * workflow profile: this is a repo edit like any other, and on a `review`
 * project it correctly goes through a worktree and a PR. It carries a
 * {@link ChatPurpose} whose `kind` IS the task id, so the sidebar recognizes it
 * without a mapping table.
 */
import { basename, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  AGENT_TASKS,
  CONFIG_DIR_NAME,
  DEFAULT_AGENTS_DIR,
  DEFAULT_INSTRUCTIONS_DIR,
  DEFAULT_MODES_DIR,
  DEFAULT_SKILLS_DIR,
  LEGACY_CONFIG_DIR_NAME,
  MANIFEST_FILE,
  composeMessageText,
  projectToManifest,
  renderManifestYaml,
  resolveWorkflow,
  taskTitlePrefix,
  withTitlePrefix,
  type AgentTaskId,
  type Chat,
  type Effort,
  type GitFileChange,
  type GitStatus,
  type MessagePart,
  type Project,
  type ProjectConfig,
} from "@dispatch/shared";
import type { Services } from "./container.js";
import type { MemoryInventoryEntry } from "./memory.js";
import { shardMemories, type MemoryShard } from "./memory-shard.js";
import { createChat, ensureSession } from "../routes/dispatch.js";

/* ------------------------------------------------------------- config dirs */

/** The config dir names actually in force for a project (manifest-overridable). */
interface ConfigDirs {
  configDir: string;
  instructions: string;
  agents: string;
  modes: string;
  skills: string;
  manifest: string;
}

function dirsFor(config: ProjectConfig | null): ConfigDirs {
  // Names, not absolute paths: the prompt reads better as repo-relative, and the
  // agent resolves them from the repo root it's already working in.
  const configDir = config?.sourceDir ? basename(config.sourceDir) : CONFIG_DIR_NAME;
  const rel = (abs: string | undefined, fallback: string) => (abs ? basename(abs) : fallback);
  return {
    configDir,
    instructions: rel(config?.instructionsDir, DEFAULT_INSTRUCTIONS_DIR),
    agents: rel(config?.agentsDir, DEFAULT_AGENTS_DIR),
    modes: rel(config?.modesDir, DEFAULT_MODES_DIR),
    skills: rel(config?.skillsDir, DEFAULT_SKILLS_DIR),
    manifest: MANIFEST_FILE,
  };
}

/* ------------------------------------------------------------ config briefs */

/** Per-config-section briefing: where the artifact lives + its house rules. */
interface ConfigBrief {
  location: (dirs: ConfigDirs) => string;
  rules: (dirs: ConfigDirs) => string[];
}

const CONFIG_BRIEFS: Record<string, ConfigBrief> = {
  "config:instructions": {
    location: (d) => `${d.configDir}/${d.instructions}/<name>.md`,
    rules: (d) => [
      `Write the prose to \`${d.configDir}/${d.instructions}/<name>.md\`, then register it ` +
        `in \`${d.configDir}/${d.manifest}\` under \`instructions:\` as ` +
        `\`- file: <name>.md\` (paths there are relative to the instructions dir). ` +
        `A file that isn't listed in the manifest is NOT loaded.`,
      `Instructions are appended to the system prompt of EVERY session in this project, ` +
        `on every turn. Keep it short and imperative; this is not documentation.`,
      `Say what the agent must do differently here. Don't restate general good practice, ` +
        `and don't duplicate what CLAUDE.md or the workflow profile already covers.`,
    ],
  },
  "config:agents": {
    location: (d) => `${d.configDir}/${d.agents}/<id>.md`,
    rules: (d) => [
      `One markdown file per agent at \`${d.configDir}/${d.agents}/<id>.md\`, with YAML ` +
        `frontmatter and the agent's system prompt as the body. Read a sibling file first ` +
        `if one exists and match it exactly.`,
      "Frontmatter keys: `name` (required), `description`, `permissionMode` " +
        "(`default` | `acceptEdits` | `bypassPermissions` | `plan`), `model`, " +
        "`allowedTools` / `disallowedTools` (lists of tool names).",
      "Scope the tool allowlist to what the job needs — a reviewer that can't write files " +
        "is a better reviewer. Prefer `plan` permission mode for anything read-only.",
      "The body IS the agent's prompt. Write it as instructions to that agent, in the " +
        "second person, not as a description of it.",
    ],
  },
  "config:modes": {
    location: (d) => `${d.configDir}/${d.modes}/<id>.yaml`,
    rules: (d) => [
      `One YAML file per mode at \`${d.configDir}/${d.modes}/<id>.yaml\`.`,
      "Keys: `name` (required), `description`, `permissionMode` (required: `default` | " +
        "`acceptEdits` | `bypassPermissions` | `plan`), optional `allowedTools` / " +
        "`disallowedTools`, and an optional `instructions` overlay.",
      "A mode is a POSTURE a human picks per chat (how much the agent may do without " +
        "asking) — not a job description. If you're writing a job, it's an agent instead.",
    ],
  },
  "config:skills": {
    location: (d) => `${d.configDir}/${d.skills}/<name>/SKILL.md`,
    rules: (d) => [
      `Either a directory \`${d.configDir}/${d.skills}/<name>/SKILL.md\` (plus any ` +
        `supporting files it references) or a single flat \`${d.configDir}/${d.skills}/<name>.md\`. ` +
        `Use a directory whenever the skill ships scripts, templates or reference docs.`,
      "Frontmatter needs `name` and `description`. The description is what makes the skill " +
        "FIRE — write it as trigger conditions (\"use when the user asks to …\"), not as a " +
        "summary, or the model will never load it.",
      "The body is the procedure: the steps, the gotchas, the commands that actually work " +
        "in this repo. Skills are materialized into each session's `.claude/skills/`.",
    ],
  },
  "config:mcp": {
    location: (d) => `${d.configDir}/${d.manifest}`,
    rules: () => [
      "**Use the `mcp__manager__mcp_add` tool** — do not hand-edit the manifest, and do not " +
        "write `.mcp.json`, `~/.claude.json` or `.claude/settings.json`; this harness reads " +
        "none of those.",
      "Load the `mcp-setup` skill before you start: it has the real procedure and the " +
        "defaults you'd otherwise guess wrong.",
      "Secrets go in as `${VAR}` placeholders, never literal keys — this file is committed.",
      "Verify the server actually connects before reporting done.",
    ],
  },
  "config:subApps": {
    location: (d) => `${d.configDir}/${d.manifest}`,
    rules: (d) => [
      `Add an entry under \`subApps:\` in \`${d.configDir}/${d.manifest}\`.`,
      "Keys: `id`, `name`, `cwd` (relative to the repo root), and the commands `install` / " +
        "`dev` / `build` / `test`. Optional: `ports`, `env` (with `{port}` / `{portN}` " +
        "placeholders substituted from the allocated ports), `url`, `docker` (a " +
        "docker-compose file).",
      "Read the actual package.json / compose file to get the commands right — a sub-app " +
        "whose `dev` command is a guess fails the first time someone launches it.",
      "Preserve the file's existing comments and key order.",
    ],
  },
};

/** The composed briefing for a config-authoring task. */
function configBriefText(taskId: AgentTaskId, config: ProjectConfig | null): string {
  const brief = CONFIG_BRIEFS[taskId]!;
  const dirs = dirsFor(config);
  const noun = AGENT_TASKS[taskId].noun;
  return [
    `Add a ${noun} to this project's Dispatch config.`,
    "",
    `**Where it goes** — \`${brief.location(dirs)}\``,
    "",
    "**How this config works**",
    "",
    ...brief.rules(dirs).map((r) => `- ${r}`),
    "",
    "**Before you write anything**",
    "",
    `- Look at what's already in \`${dirs.configDir}/\` and match its conventions — ` +
      "naming, tone, frontmatter style. Consistency with the existing config beats " +
      "your own preferences.",
    "- Ground it in THIS repo: read the code, scripts and docs the request touches so " +
      "the result is specific rather than generic boilerplate.",
    "- If the request is ambiguous in a way that changes the result, ask me before writing.",
    "",
    "When you're done, tell me what you created and what it changes about how agents " +
      "behave here.",
  ].join("\n");
}

/* ----------------------------------------------------------- project setup */

/**
 * The project-setup briefing — the second half of the new-project form.
 *
 * The form asks for the four things a human can actually answer in thirty
 * seconds: what it's called, where it lives, which branch is the trunk, and how
 * change ships. Everything else in a real `project.yaml` — which sub-apps exist,
 * what their dev commands are, which ports they bind, what house rules the repo
 * has — is a READING job, and the form has no business guessing at it. So the
 * form saves what it knows and hands the rest here.
 *
 * The one branch that matters is whether the directory has code in it yet:
 *
 *   - an EMPTY directory means the human is starting a project, and "set it up"
 *     means scaffolding one to their brief and then recording what was built;
 *   - an EXISTING repo means the config is behind the code, and the job is to
 *     read the code and describe it — never to restructure it to match a config.
 *
 * Getting that backwards is the expensive failure: an agent that "sets up" an
 * existing repo by rewriting its build is a much worse afternoon than one that
 * writes a slightly thin manifest.
 */
function projectSetupBriefText(input: {
  repoPath: string;
  trunk: string;
  dirs: ConfigDirs;
  fresh: boolean;
  runInstall: boolean;
  /** The repo brought its own committed config; the form didn't write this file. */
  adopted: boolean;
}): string {
  const { repoPath, trunk, dirs, fresh, runInstall, adopted } = input;
  const manifest = `${dirs.configDir}/${dirs.manifest}`;

  const lines = [
    fresh
      ? "Set this project up from scratch, then record what you built in its Dispatch config."
      : "Finish this project's Dispatch config by reading the repo it points at.",
    "",
    // Which of these two sentences is true decides whether the agent may treat
    // the attached file as disposable scaffolding or as someone's committed
    // work. Getting it wrong is how a real `instructions:` block gets rewritten
    // away, so it's stated rather than left to inference.
    adopted
      ? `**The repo** — \`${repoPath}\`, trunk \`${trunk}\`. This repo ALREADY CARRIES a ` +
          `committed \`${manifest}\` — I adopted it, I did not write it. The config attached ` +
          "below is that file, read from disk. Treat it as someone's authored work: extend " +
          "it, keep every key and comment already in it, and don't re-derive it from scratch."
      : `**The repo** — \`${repoPath}\`, trunk \`${trunk}\`. I just created this project ` +
          `in Dispatch from a form that captured only the essentials; \`${manifest}\` was ` +
          "scaffolded from it and holds exactly what I typed and nothing more. The config " +
          "attached below is that file as it stands.",
    "",
  ];

  if (fresh) {
    lines.push(
      "**The directory is empty** — there is no code here yet. That makes this a build, not " +
        "an audit:",
      "",
      "- Scaffold the project described below. Where I didn't specify a stack, pick a " +
        "conventional one and TELL me what you picked and why before you commit to it — " +
        "don't quietly decide the language.",
      "- Prefer the ecosystem's own scaffolder (`create-vite`, `cargo new`, `uv init`, …) " +
        "over hand-writing files. It gets the boring parts right.",
      "- Get it to the point where the dev command actually starts and the test command " +
        "actually runs. A scaffold nobody ran is a scaffold that doesn't work.",
      "- Add a `README.md` that says what this is, and a `.gitignore` for the stack.",
      "",
    );
  } else {
    lines.push(
      "**The repo already has code** — so this is an audit, not a rewrite:",
      "",
      "- Read it. `package.json` scripts, compose files, Makefiles, CI workflows, the " +
        "README, and whatever else says how this thing is actually run.",
      "- Record what you find. Do NOT restructure the repo, rename scripts, change ports, " +
        "or \"standardize\" anything to make the config tidier — the code is the truth and " +
        "the config follows it.",
      "- If something genuinely looks broken, say so at the end; don't fix it as part of " +
        "setup.",
      "",
    );
  }

  lines.push(
    `**What to write into \`${manifest}\`**`,
    "",
    "- `subApps:` — one entry per independently runnable thing in this repo. Keys: `id`, " +
      "`name`, `cwd` (relative to the repo root), and the commands `install` / `dev` / " +
      "`build` / `test`. Optional: `ports`, `env` (with `{port}` / `{portN}` placeholders " +
      "substituted from the allocated ports), `url`, `docker` (a compose file). This is the " +
      "part that makes the Runner work, so the commands have to be the real ones.",
    "- `worktreeRoot:` is already set. Make sure it's in `.gitignore` if it resolves inside " +
      "the repo — an untracked worktree directory shows up as noise in every diff otherwise.",
    "- Leave `workflow:` alone unless what you found contradicts it (say, I picked `review` " +
      "and there's no remote). If it does, say so and let me change it — that choice is mine.",
    "- Preserve the file's existing comments and key order.",
    "",
    `**Beyond the manifest** — only where this repo actually earns it:`,
    "",
    `- \`${dirs.configDir}/${dirs.instructions}/<name>.md\` (registered under ` +
      "`instructions:` in the manifest) for house rules an agent would otherwise get " +
      "wrong here. Short and imperative, and only for things that are TRUE of this repo — " +
      "a generic \"write clean code\" file is worse than no file.",
    `- \`${dirs.configDir}/${dirs.skills}/<name>/SKILL.md\` for a multi-step procedure this ` +
      "repo has that isn't obvious from the code (a release ritual, a data reset).",
    "- Skip both if you'd be inventing. An empty config beats a confident wrong one.",
    "",
    runInstall
      ? "**Verify before you claim done** — run the install command, then the dev and test " +
          "commands you wrote down (start dev, confirm it binds the port you recorded, stop " +
          "it). Fix the manifest to match what actually happened, not what the scripts " +
          "implied."
      : "**Don't run anything** — I've asked you to record the commands without executing " +
          "them. Read them out of the scripts and config files, and flag anything you " +
          "couldn't confirm by reading alone.",
    "",
    "When you're done: tell me what this project is, what sub-apps you registered and how " +
      "to run each one, and anything you deliberately left out of the config.",
  );
  return lines.join("\n");
}

/**
 * Is the project directory effectively empty — i.e. is this a brand-new project
 * rather than an existing checkout? `.git` and `.dispatch` don't count: the
 * create flow just made both, so a repo that has only those has no code in it.
 */
async function isFreshRepo(repoPath: string): Promise<boolean> {
  try {
    const entries = await readdir(repoPath);
    return entries.every((e) => e === ".git" || e === CONFIG_DIR_NAME || e === LEGACY_CONFIG_DIR_NAME);
  } catch {
    // An unreadable path is not evidence of emptiness — the safer briefing is
    // the one that tells the agent to read before it writes.
    return false;
  }
}

/**
 * The project's manifest AS IT IS ON DISK, plus whether the repo brought it.
 *
 * Never re-derived from the stored record. `projectToManifest` emits the five
 * keys `.data` knows about and nothing else, so re-deriving an ADOPTED repo's
 * manifest produces a file missing its `instructions:`, its dir overrides and
 * every comment — and handing the agent that, labelled "as saved", is an
 * instruction to delete them.
 *
 * `adopted` is decided by content, not by timing: a scaffolded manifest is
 * byte-identical to what `projectToManifest` renders, so anything that ISN'T is
 * a file the repo already had.
 */
async function readSavedManifest(
  config: ProjectConfig | null,
  project: Project,
): Promise<{ text: string; adopted: boolean }> {
  const synthesized = renderManifestYaml(projectToManifest(project));
  if (!config?.sourceDir) return { text: synthesized, adopted: false };
  try {
    const text = await readFile(join(config.sourceDir, MANIFEST_FILE), "utf8");
    return { text, adopted: text.trim() !== synthesized.trim() };
  } catch {
    // No readable file (a race with the scaffold, a permissions problem): the
    // derived one still describes the record the agent is working for.
    return { text: synthesized, adopted: false };
  }
}

/* ------------------------------------------------------------ commit sweep */

/**
 * The commit-sweep briefing: land a dirty working tree as a series of coherent,
 * per-feature commits.
 *
 * The failure modes this is written against, in the order they actually happen:
 *
 *   1. `git add -A && git commit -m "updates"` — one commit, no grouping. The
 *      whole point of the task is the grouping, so paths are explicit and
 *      add-all is banned outright.
 *   2. Committing junk — a stray `.env`, build output, a scratch file, a debug
 *      `console.log`. A sweep is unsupervised by design, so it must LEAVE
 *      anything questionable behind and say so rather than ask.
 *   3. History rewriting. An agent that hits a snag reaches for `amend`,
 *      `reset`, `rebase` or a force-push; on a shared branch that is the one
 *      unrecoverable outcome here.
 *   4. Losing the human's staging. Someone who already staged a subset meant it,
 *      so that becomes the first group rather than being reshuffled.
 */
function commitSweepBriefText(input: {
  repoPath: string;
  status: GitStatus | null;
  push: boolean;
  includeUntracked: boolean;
}): string {
  const { status, push, includeUntracked } = input;
  const lines = [
    "Land everything in this working tree as a series of commits, one per coherent change.",
    "",
    `**The repo** — \`${input.repoPath}\`` +
      (status?.branch ? ` on branch \`${status.branch}\`` : " (detached HEAD)"),
    "",
    "**How to group**",
    "",
    "- Read the actual diffs first (`git diff`, `git diff --staged`, and the untracked " +
      "files' contents). Group by CHANGE, not by directory: a feature that touched a " +
      "schema, a route and a test is one commit; two unrelated fixes in one file are two.",
    "- Aim for the smallest number of commits that keeps each one independently " +
      "reviewable. If you genuinely cannot tell whether two edits are related, they're " +
      "separate — an over-split history is recoverable, a tangled commit isn't.",
    "- Order them so the tree builds at each step where that's cheap to arrange " +
      "(types/shared before the callers that use them).",
  ];

  if (status?.staged.length) {
    lines.push(
      `- Something is ALREADY STAGED (${status.staged.length} ` +
        `${status.staged.length === 1 ? "path" : "paths"}). Treat that as a deliberate ` +
        "grouping by the human: commit it first, as-is, unless it's obviously " +
        "unrelated files swept in by an earlier `add -A`.",
    );
  }

  lines.push(
    "",
    "**How to commit**",
    "",
    "- Stage each group with explicit pathspecs — `git add -- <path> <path>`. Do NOT use " +
      "`git add -A`, `git add .`, or `git commit -a`: they defeat the grouping and pull in " +
      "files you decided to leave out.",
    "- One `git commit` per group. Match this repo's existing message style — read " +
      "`git log --oneline -20` and follow it (conventional-commit prefixes only if the " +
      "repo already uses them). Subject under 72 chars, imperative; a short body only " +
      "when the WHY isn't obvious.",
    "- Verify after each commit that you staged what you meant to (`git show --stat HEAD`).",
    "",
    "**Leave alone**",
    "",
    "- Anything that looks like a secret, a credential, a local-only config, build output, " +
      "a lockfile you didn't intend to touch, or a scratch/debug edit. Leave it " +
      "uncommitted and tell me why at the end — do not ask mid-run, and do not commit it " +
      "\"to be safe\".",
    "- Never `git amend`, `reset`, `rebase`, `checkout --`, `restore`, `stash drop` or " +
      "force-push. Never touch another branch. If a commit goes wrong, STOP and report it " +
      "rather than rewriting history to fix it.",
  );

  if (!includeUntracked) {
    lines.push(
      "- Untracked files are OUT of scope for this sweep — commit only paths git already " +
        "tracks.",
    );
  }

  lines.push(
    "",
    push
      ? "**When the commits are in** — push the branch (`git push`, setting upstream if it " +
          "has none). Push only; never force."
      : "**When the commits are in** — do NOT push. Leave the commits local; I'll push.",
    "",
    "Finish with a short report: one line per commit (subject + why those files belong " +
      "together), then anything you deliberately left uncommitted.",
  );
  return lines.join("\n");
}

/** Compact `<status> <path>` inventory of a change list, bounded. */
function inventory(files: GitFileChange[], max = 60): string[] {
  const out = files
    .slice(0, max)
    .map((f) => `  ${f.status.padEnd(9)} ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`);
  if (files.length > max) out.push(`  … and ${files.length - max} more`);
  return out;
}

/**
 * The working-tree snapshot attached to a sweep as invisible context.
 *
 * The agent could run `git status` itself, and will. This is here so the FIRST
 * turn is already grounded — and so the transcript records the tree as it was at
 * launch, which is the only way to read the sweep's decisions back later once
 * the tree is clean.
 */
function worktreeSnapshot(status: GitStatus): string | null {
  const groups: [string, GitFileChange[]][] = [
    ["Staged", status.staged],
    ["Modified", status.unstaged],
    ["Untracked", status.untracked],
    ["Conflicted", status.conflicted],
  ];
  const sections = groups
    .filter(([, files]) => files.length > 0)
    .map(([title, files]) => [`${title} (${files.length}):`, ...inventory(files)].join("\n"));
  if (!sections.length) return null;
  const head = [
    `Working tree at ${status.repoPath}`,
    status.branch ? `branch ${status.branch}` : "detached HEAD",
    status.upstream ? `tracking ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})` : "no upstream",
  ].join(" · ");
  return [head, "", ...sections].join("\n");
}

/* ----------------------------------------------------- memory consolidation */

/**
 * The consolidation briefing: audit a project's whole durable-memory store,
 * merge what's duplicated, retire what's wrong, and leave the rest verifiable.
 *
 * Memory accumulates monotonically by design — `remember` is cheap, deliberately
 * so, and the dedup nudge on write is a hint an agent may ignore. After a few
 * months a real store is 140 facts of which a third are the same three facts
 * written five different ways, and the cost lands on every single session: the
 * standing-rules tier is injected in full, and the auto-surface picks between
 * near-identical candidates on lexical noise.
 *
 * The failure modes this is written against, in the order they actually happen:
 *
 *   1. One agent reads all 140 and "consolidates" from a context where it can no
 *      longer remember the first forty. Hence the fan-out, and hence shards cut
 *      by CONTENT similarity (see services/memory-shard.ts) so a duplicate pair
 *      is always visible to one agent rather than split across two.
 *   2. Deleting what's merely UNUSED. Access telemetry is young and only counts
 *      retrievals since it shipped; "never recalled" is a prompt to look, not a
 *      verdict. Deletion is for facts that are wrong, superseded, or duplicated.
 *   3. Merging by topic instead of by fact. Two memories about the same
 *      subsystem are not one memory, and a merge that concatenates them produces
 *      something too long to inject and too vague to act on.
 *   4. Losing the WHY. The rationale line is the most valuable part of a
 *      feedback memory and the first thing a summarizer drops.
 *   5. Breaking the `[[link]]` graph — deleting or renaming a memory that three
 *      others point at, leaving three dangling references nobody notices.
 *   6. Subagents writing concurrently. They audit; the orchestrator applies. One
 *      writer means one auditable plan and no interleaved partial merges.
 */
function memoryConsolidateBriefText(input: {
  total: number;
  shards: MemoryShard[];
  apply: boolean;
  verify: boolean;
  includeRules: boolean;
  ruleCount: number;
  /** Memory here is committed by the workflow profile → history is readable. */
  committed: boolean;
}): string {
  const { total, shards, apply, verify, includeRules, ruleCount, committed } = input;
  const dupeGroups = shards.reduce((n, s) => n + s.duplicates.length, 0);

  const lines = [
    `Audit and consolidate this project's durable memory — ${total} recorded ` +
      `${total === 1 ? "fact" : "facts"} in scope.`,
    "",
    "**Why this matters** — every one of these is injected or offered to every session in " +
      "this project. A duplicate doesn't just waste context: it makes the auto-surface pick " +
      "between near-identical candidates on lexical noise, so the WORSE copy of a fact wins " +
      "half the time. A stale fact is worse still — agents act on it.",
    "",
    "**Your tools** — `mcp__manager__memory_list` (inventory with size, age, retrieval " +
      "counts and `[[link]]` neighbours in both directions), `memory_search` (exhaustive " +
      "literal/regex search — use this, not `recall`, when a partial answer would be " +
      "wrong), `memory_similar` (near-duplicate detection), " +
      (committed
        ? "`memory_history` (git history: when a fact was written, how often it's been " +
          "rewritten, and which facts were deliberately RETIRED)"
        : "`memory_history` (probably unavailable here — this project's memory isn't " +
          "committed, so there may be no history to read; check once, don't keep trying)") +
      ", and `remember` / `forget` to apply.",
    "",
  ];

  /* ------------------------------------------------------------- the fan-out */

  lines.push(
    `**Fan out — ${shards.length} ${shards.length === 1 ? "shard" : "shards"}**`,
    "",
    "Spawn one subagent per shard with the Agent tool, IN PARALLEL (all of them in a " +
      "single message — one Agent call per shard). The shards below are cut by content " +
      "similarity, not alphabetically, so any two memories that look like the same fact " +
      "are in the SAME shard and one agent can see both. Don't re-cut them.",
    "",
    "Each subagent is READ-ONLY. It must not call `remember` or `forget` — it reports " +
      "verdicts and you apply them. Concurrent writers here produce interleaved partial " +
      "merges and a plan nobody can review.",
    "",
    "Give each subagent its shard's memory names, the judging rules below, and this " +
      "contract — one verdict per memory in its shard:",
    "",
    "```",
    "<name> — KEEP | EDIT | MERGE→<survivor> | DELETE",
    "  why: <one line of evidence — a file path, a commit, a contradicting memory>",
    "  edit: <the replacement description/body, for EDIT and for a MERGE survivor>",
    "```",
    "",
  );

  for (const s of shards) {
    lines.push(`Shard ${s.index}/${shards.length} — ${s.label} (${s.names.length}):`);
    lines.push(`  ${s.names.join(", ")}`);
    for (const g of s.duplicates) {
      lines.push(`  ⚠ likely the same fact: ${g.join(" ≈ ")}`);
    }
    lines.push("");
  }

  /* -------------------------------------------------------------- the rules */

  lines.push(
    "**How to judge each memory**",
    "",
    "- DELETE is for a fact that is WRONG, SUPERSEDED by the current code, or fully " +
      "contained in another memory. It is NOT for a fact that merely hasn't been used: " +
      "retrieval counts only started when that telemetry shipped, and a rarely-needed fact " +
      "that saves an hour when it IS needed is exactly what this store is for. " +
      "\"Never retrieved\" means look harder, not delete.",
    "- MERGE only when two memories state the SAME fact. Two facts about one subsystem are " +
      "two facts; concatenating them yields something too long to inject and too vague to " +
      "act on. If you can't state the merged fact in one sentence, don't merge.",
    "- When merging, the survivor keeps the name most likely to be linked or searched for, " +
      "and inherits the UNION of the specifics — every path, flag, error string and " +
      "reproduction the copies carried between them. A merge that loses a detail is a " +
      "deletion wearing a merge's clothes.",
    "- Keep the **Why:** line. The rationale is the most valuable part of a feedback memory " +
      "and the first thing a summarizer drops. Same for \"How to apply\".",
    "- Check `[[link]]` backlinks before you delete or rename (`memory_list` reports them). " +
      "If other memories point at this one, either keep the name or fix every inbound link " +
      "as part of the change — a dangling `[[link]]` is invisible until it isn't.",
    "- EDIT — not DELETE — when a fact is right but stale in its details, over-long, or " +
      "buried under a description that doesn't say what it's for. The description is the " +
      "retrieval signal; a vague one means the fact never surfaces when it's needed.",
  );

  if (verify) {
    lines.push(
      "- VERIFY each claim against the repo before keeping it. A memory that names a file, " +
        "function, flag, port or command is checkable — go check. Read the code, run " +
        "`git log` on what it describes. A fact that no longer matches the code is stale " +
        "even if it's beautifully written, and this is the one part of the job that " +
        "genuinely requires reading the repo rather than reading the memory.",
    );
  } else {
    lines.push(
      "- Do NOT go verify claims against the repo — I've asked for a memory-only pass. " +
        "Judge duplication, contradiction between memories, and clarity. Flag anything you " +
        "suspect is stale rather than acting on the suspicion.",
    );
  }

  if (!includeRules) {
    lines.push(
      `- The ${ruleCount} standing ${ruleCount === 1 ? "rule" : "rules"} (\`user\` and ` +
        "`feedback` memories) are OUT of scope for this pass. Don't audit them, don't merge " +
        "them, don't touch them — they aren't in the shards above.",
    );
  } else if (ruleCount) {
    lines.push(
      `- Be conservative with the ${ruleCount} standing ${ruleCount === 1 ? "rule" : "rules"} ` +
        "(`user` and `feedback`). Those are the human's own preferences and corrections, not " +
        "your observations about the code, and you can't verify one against the repo. Merge " +
        "a rule only when two are unmistakably the same instruction; never delete one for " +
        "being stale unless the code it refers to is provably gone.",
    );
  }

  /* -------------------------------------------------------- the cross pass */

  lines.push(
    "",
    "**When the subagents come back — the cross-shard pass**",
    "",
    "Sharding guarantees that obvious duplicates were visible to one agent. It does NOT " +
      "catch two facts that resemble each other below the clustering bar — usually the same " +
      "lesson written months apart in different vocabulary. So before you apply anything: " +
      "run `memory_similar` with `threshold: 0.25` on each proposed survivor, and reconcile " +
      "any hit that lands in a different shard yourself.",
    "",
    "Also reconcile CONTRADICTIONS the shards couldn't see: two memories that state " +
      "incompatible things about the same subsystem. When you find one, the newer fact " +
      "usually wins — check `memory_history` before assuming that.",
    "",
  );

  /* ------------------------------------------------------------- apply/report */

  if (apply) {
    lines.push(
      "**Applying**",
      "",
      "- YOU apply, not the subagents, and only after the cross-shard pass — so the whole " +
        "plan is decided before the first write.",
      "- Show me the plan first: one line per change (`merge a + b → c`, `delete d — " +
        "superseded by e`, `edit f — description didn't say what it was for`), grouped by " +
        "kind, with counts. Then apply it without waiting — I'll stop you if it's wrong.",
      "- Write the survivor FIRST (`remember` with the merged body), then `forget` the " +
        "copies. That order means an interruption leaves a duplicate, which is harmless; " +
        "the other order loses the fact.",
      "- Don't touch anything a subagent marked KEEP. A quiet rewrite of a fact nobody " +
        "flagged is the change I have no way to review.",
      committed
        ? "- Each write lands as a `chore(memory)` commit automatically — you don't need to " +
          "commit anything, and you should not `git add` the memory dir yourself."
        : "- Memory here isn't committed by the workflow profile, so the writes land on disk " +
          "only. Don't commit them yourself.",
    );
  } else {
    lines.push(
      "**Report only**",
      "",
      "- I've asked for the plan, NOT the changes. Do not call `remember` or `forget`, and " +
        "do not edit anything under the memory dir.",
      "- Give me the full plan: one line per proposed change with its evidence, grouped by " +
        "kind. Make it concrete enough that I can approve it and have you execute it in a " +
        "follow-up message.",
    );
  }

  lines.push(
    "",
    "Finish with the numbers — how many kept, merged, edited, deleted, and what the store " +
      "went from and to — then anything you deliberately left alone and why. If a whole area " +
      "turned out to be fine, say so; that's a useful result, not a failed pass.",
  );

  if (dupeGroups) {
    lines.push(
      "",
      `(${dupeGroups} suspected-duplicate ${dupeGroups === 1 ? "group is" : "groups are"} ` +
        "flagged in the shards above. That's a lexical signal, not a verdict — read both " +
        "bodies before merging.)",
    );
  }

  return lines.join("\n");
}

/**
 * The inventory attached to a consolidation as context: every memory in scope,
 * one row each, with the signals that decide whether it stays.
 *
 * The agent will call `memory_list` too. This is here so the first turn is
 * already grounded in the shape of the store — and so the transcript records
 * what the store looked like BEFORE the pass, which is the only way to read the
 * consolidation's decisions back once the duplicates are gone.
 */
function memoryInventoryText(rows: readonly MemoryInventoryEntry[], max = 250): string {
  const shown = rows.slice(0, max);
  const lines = shown.map((m) => {
    const age = m.updatedAt ? new Date(m.updatedAt).toISOString().slice(0, 10) : "undated";
    const use =
      m.surfaced === 0 && m.recalled === 0 ? "never retrieved" : `${m.recalled}r/${m.surfaced}s`;
    const graph = [
      m.links.length ? `→${m.links.length}` : "",
      m.backlinks.length ? `←${m.backlinks.length}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      `${m.name}  [${m.type}, ${m.bytes}c, ${age}, ${use}${graph ? `, ${graph}` : ""}]\n` +
      `    ${m.description || "(no description)"}`
    );
  });
  if (rows.length > shown.length) {
    lines.push(`… and ${rows.length - shown.length} more (read them with memory_list)`);
  }
  return [
    "name  [type, body size, last write, retrievals, link degree]",
    "    description",
    "",
    ...lines,
  ].join("\n");
}

/* ----------------------------------------------------------------- assembly */

/** Everything a task's briefing can draw on, resolved before composition. */
interface BriefContext {
  taskId: AgentTaskId;
  instructions: string;
  params: Record<string, unknown>;
  config: ProjectConfig | null;
  status: GitStatus | null;
  repoPath: string;
  /** The stored record — project setup briefs the agent about the project itself. */
  project?: Project | null;
  /** Project setup only: the directory has no code in it yet (see `isFreshRepo`). */
  fresh?: boolean;
  /** Project setup only: the manifest as it is ON DISK (see `readSavedManifest`). */
  savedManifest?: { text: string; adopted: boolean };
  /** Memory consolidation only: the store to audit, already filtered to scope. */
  memory?: MemoryConsolidationContext;
}

/** Everything a consolidation briefing needs about the store it's auditing. */
interface MemoryConsolidationContext {
  /** The rows in scope (rules excluded when the human turned them off). */
  rows: MemoryInventoryEntry[];
  /** How the work fans out — one shard per subagent. */
  shards: MemoryShard[];
  /** Standing rules (`user` + `feedback`) in the store, in scope or not. */
  ruleCount: number;
  /** This project's profile commits memory → `memory_history` has something to read. */
  committed: boolean;
}

const boolParam = (params: Record<string, unknown>, id: string, fallback: boolean): boolean =>
  typeof params[id] === "boolean" ? (params[id] as boolean) : fallback;

/**
 * Compose a task's message parts. The parts ARE the message (see
 * `composeMessageText`) and they are what the transcript renders, so this is the
 * one place that decides both what the model reads and what the human sees
 * attributed to whom.
 */
export function buildTaskParts(ctx: BriefContext): MessagePart[] {
  const meta = AGENT_TASKS[ctx.taskId];
  const parts: MessagePart[] = [];

  if (ctx.taskId === "git:commit-sweep") {
    parts.push({
      kind: "brief",
      label: "Commit sweep",
      text: commitSweepBriefText({
        repoPath: ctx.repoPath,
        status: ctx.status,
        push: boolParam(ctx.params, "push", false),
        includeUntracked: boolParam(ctx.params, "includeUntracked", true),
      }),
    });
  } else if (ctx.taskId === "memory:consolidate") {
    const mem = ctx.memory;
    parts.push({
      kind: "brief",
      label: `Memory consolidation — ${mem?.rows.length ?? 0} facts, ${
        mem?.shards.length ?? 0
      } shards`,
      text: memoryConsolidateBriefText({
        total: mem?.rows.length ?? 0,
        shards: mem?.shards ?? [],
        apply: boolParam(ctx.params, "apply", true),
        verify: boolParam(ctx.params, "verify", true),
        includeRules: boolParam(ctx.params, "includeRules", true),
        ruleCount: mem?.ruleCount ?? 0,
        committed: mem?.committed ?? false,
      }),
    });
  } else if (ctx.taskId === "project:setup") {
    parts.push({
      kind: "brief",
      label: ctx.fresh ? "Project setup — empty directory" : "Project setup — existing repo",
      text: projectSetupBriefText({
        repoPath: ctx.repoPath,
        trunk: ctx.project?.defaultBranch || "main",
        dirs: dirsFor(ctx.config),
        fresh: ctx.fresh ?? false,
        runInstall: boolParam(ctx.params, "runInstall", true),
        adopted: ctx.savedManifest?.adopted ?? false,
      }),
    });
  } else {
    parts.push({
      kind: "brief",
      label: `${meta.action} — how this config works`,
      text: configBriefText(ctx.taskId, ctx.config),
    });
  }

  const instructions = ctx.instructions.trim();
  if (instructions) {
    parts.push({ kind: "instructions", label: "What I want", text: instructions });
  }

  // The manifest as it is ON DISK, verbatim. The agent could open the file (and
  // will), but attaching it means the first turn is already grounded in what is
  // actually there — and the transcript records the starting point, which is the
  // only way to read the setup's decisions back later.
  if (ctx.taskId === "project:setup" && ctx.savedManifest) {
    parts.push({
      kind: "context",
      label:
        `${dirsFor(ctx.config).configDir}/${MANIFEST_FILE}` +
        (ctx.savedManifest.adopted ? " — already in this repo" : " as saved"),
      text: ctx.savedManifest.text,
    });
  }

  if (ctx.taskId === "memory:consolidate" && ctx.memory?.rows.length) {
    parts.push({
      kind: "context",
      label: `Memory at launch — ${ctx.memory.rows.length} facts in scope`,
      text: memoryInventoryText(ctx.memory.rows),
    });
  }

  if (ctx.taskId === "git:commit-sweep" && ctx.status) {
    const snapshot = worktreeSnapshot(ctx.status);
    if (snapshot) {
      const changed =
        ctx.status.staged.length +
        ctx.status.unstaged.length +
        ctx.status.untracked.length +
        ctx.status.conflicted.length;
      parts.push({
        kind: "context",
        label: `Working tree at launch — ${changed} ${changed === 1 ? "path" : "paths"}`,
        text: snapshot,
      });
    }
  }

  return parts;
}

/**
 * Resolve the store a consolidation is about to audit, and cut it into shards.
 *
 * The scope filter is applied HERE rather than left to the briefing, so the
 * shards, the attached inventory and the instructions can't disagree about what
 * is in scope: with standing rules turned off, the agent never even sees their
 * names, which is a much stronger guarantee than asking it not to touch them.
 *
 * Degrades rather than fails — an unreadable store yields an empty context and
 * a briefing that says so, which is a chat the human can act on. A failed launch
 * is not.
 */
async function readMemoryContext(
  services: Services,
  projectId: string,
  project: Project,
  params: Record<string, unknown>,
): Promise<MemoryConsolidationContext> {
  const empty: MemoryConsolidationContext = {
    rows: [],
    shards: [],
    ruleCount: 0,
    committed: false,
  };
  const all = await services.memory.inventory(projectId).catch(() => []);
  if (!all.length) return empty;

  const ruleCount = all.filter((m) => m.type === "user" || m.type === "feedback").length;
  const includeRules = typeof params.includeRules === "boolean" ? params.includeRules : true;
  const rows = includeRules
    ? all
    : all.filter((m) => m.type === "project" || m.type === "reference");

  return {
    rows,
    shards: shardMemories(rows),
    ruleCount,
    // `memory: "commit"` is what makes MemoryCommitter land each write as a real
    // commit, which is the only reason `memory_history` has anything to read.
    committed: resolveWorkflow(project).memory === "commit",
  };
}

/* ------------------------------------------------------------------ launch */

export interface LaunchAgentTaskResult {
  chat: Chat;
  /** The composed opening message (also sent to the chat). */
  prompt: string;
  parts: MessagePart[];
}

/**
 * Launch a task: resolve its context, compose the briefing, spawn the chat and
 * send it. Returns the chat so the caller can jump straight in and watch — the
 * work is visible there, not behind a spinner in whatever dialog launched it.
 */
export async function launchAgentTask(
  services: Services,
  input: {
    projectId: string;
    taskId: AgentTaskId;
    instructions?: string;
    effort?: Effort;
    model?: string;
    params?: Record<string, unknown>;
  },
): Promise<LaunchAgentTaskResult | null> {
  const project = await services.store.getProject(input.projectId).catch(() => null);
  if (!project) return null;

  const meta = AGENT_TASKS[input.taskId];
  const params = input.params ?? {};
  const instructions = (input.instructions ?? "").trim();
  const isGit = input.taskId === "git:commit-sweep";

  // A sweep targets whichever repo the Source Control view is pointed at — often
  // a worktree, not the checkout — so the caller's path wins over the project's.
  const repoPath =
    (typeof params.repoPath === "string" && params.repoPath.trim()) || project.repoPath;

  // Config tasks need the resolved dir layout; git tasks need the live status.
  // Each is only fetched for the task that reads it, and a failure degrades the
  // briefing rather than failing the launch.
  const config = isGit
    ? null
    : (services.projectConfig.get(input.projectId)?.config ??
      (await services.projectConfig.reload(input.projectId).catch(() => null))?.config ??
      null);
  const status = isGit ? await services.git.status(repoPath).catch(() => null) : null;
  // Setup reads the directory itself: "is there code here yet" is the one fact
  // that decides whether this is a build or an audit (see projectSetupBriefText).
  const fresh = input.taskId === "project:setup" ? await isFreshRepo(repoPath) : false;
  const savedManifest =
    input.taskId === "project:setup" ? await readSavedManifest(config, project) : undefined;
  const memory =
    input.taskId === "memory:consolidate"
      ? await readMemoryContext(services, input.projectId, project, params)
      : undefined;

  const parts = buildTaskParts({
    taskId: input.taskId,
    instructions,
    params,
    config,
    status,
    repoPath,
    project,
    fresh,
    savedManifest,
    memory,
  });
  const prompt = composeMessageText(parts);

  const chat = await createChat(services, {
    projectId: input.projectId,
    // `**category**: the ask`. The ask is what makes the row scannable a week
    // later, so it takes the width; the category is emphasized (the client
    // accents anything in `**`) because it's what the eye scans FOR. A task
    // with no instructions falls back to something concrete about the target.
    title: withTitlePrefix(
      taskTitlePrefix(input.taskId),
      instructions
        ? summarize(instructions)
        : input.taskId === "project:setup"
          ? project.name
          : input.taskId === "memory:consolidate"
            ? consolidateSubject(memory)
            : sweepSubject(status),
    ),
    effort: input.effort ?? meta.defaultEffort,
    model: input.model ?? meta.defaultModel,
    purpose: {
      kind: input.taskId,
      label: taskLabel(input.taskId, status, project, memory),
    },
  });

  await ensureSession(services, chat.id);
  await services.broker.sendMessage(chat.id, prompt, { parts });
  return { chat, prompt, parts };
}

/** The sidebar's one-line "what is this chat off doing". */
function taskLabel(
  taskId: AgentTaskId,
  status: GitStatus | null,
  project?: Project,
  memory?: MemoryConsolidationContext,
): string {
  const meta = AGENT_TASKS[taskId];
  if (taskId === "project:setup") {
    return project ? `Setting up ${project.name}` : "Setting this project up";
  }
  if (taskId === "memory:consolidate") {
    const n = memory?.rows.length ?? 0;
    return n
      ? `Consolidating ${n} durable ${n === 1 ? "fact" : "facts"} across ${
          memory?.shards.length ?? 0
        } agents`
      : "Consolidating this project's durable memory";
  }
  if (taskId !== "git:commit-sweep") {
    return `Writing a ${meta.noun} for this project's config`;
  }
  return status?.branch
    ? `Grouping the working tree into commits on ${status.branch}`
    : "Grouping the working tree into commits";
}

/** The title's subject for a consolidation — the scale of what it's chewing on. */
function consolidateSubject(memory: MemoryConsolidationContext | undefined): string {
  const n = memory?.rows.length ?? 0;
  if (!n) return "";
  const shards = memory?.shards.length ?? 0;
  return `${n} ${n === 1 ? "fact" : "facts"}${shards > 1 ? `, ${shards} shards` : ""}`;
}

/**
 * The title's subject line for a task launched with no instructions of its own —
 * the sweep, in practice. Empty when there's nothing concrete to say, leaving
 * the title as just its emphasized prefix.
 */
function sweepSubject(status: GitStatus | null): string {
  const changed = status
    ? status.staged.length +
      status.unstaged.length +
      status.untracked.length +
      status.conflicted.length
    : 0;
  if (!changed) return "";
  return `${changed} ${changed === 1 ? "file" : "files"}${
    status?.branch ? ` on ${status.branch}` : ""
  }`;
}

/** First clause of the request, bounded — the chat title, not the whole brief. */
function summarize(description: string, max = 48): string {
  const line = description.trim().split("\n").find((l) => l.trim())?.trim() ?? "task";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
