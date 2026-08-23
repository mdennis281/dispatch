/**
 * Mock fixture — a realistic offline dataset typed against @dispatch/shared, used to
 * seed the stores so the shell renders exactly as it will with a live backend.
 * 2b replaces this seed with REST snapshots + the WS stream; the store shapes
 * and component props do not change.
 */
import type {
  Project,
  Chat,
  ChatMessage,
  AgentConfig,
  ModeConfig,
  AttentionItem,
  RunnerInstance,
  WorktreeInfo,
  PRInfo,
  WorkflowRun,
} from "@dispatch/shared";

const now = Date.now();
const ago = (min: number) => now - min * 60_000;

/* ------------------------------------------------------------------ project */

export const MOCK_PROJECT: Project = {
  id: "hivebreak",
  name: "Hivebreak",
  repoPath: "C:/Users/Michael/projects/zombie",
  worktreeRoot: "C:/Users/Michael/projects/zombie-worktrees",
  worktreeCmd: "pnpm worktree",
  shipCmd: "pnpm ship",
  defaultBranch: "main",
  createdAt: ago(60 * 24 * 9),
  subApps: [
    {
      id: "game",
      name: "game",
      path: "apps/client",
      dev: "pnpm dev",
      build: "pnpm build",
      ports: [5173],
      url: "http://localhost:{port}",
    },
    {
      id: "metrics-server",
      name: "metrics-server",
      path: "services/metrics-server",
      dev: "docker compose up",
      dockerCompose: "docker-compose.yml",
      ports: [8080, 5432],
      url: "http://localhost:{port}",
    },
    {
      id: "studio-director",
      name: "studio-director",
      path: "tools/studio-director",
      dev: "node server.mjs",
      ports: [7777],
      url: "http://localhost:{port}",
    },
  ],
};

export const MOCK_PROJECTS: Project[] = [MOCK_PROJECT];

/* --------------------------------------------------------- agents & modes */

export const MOCK_MODES: ModeConfig[] = [
  { id: "plan", name: "Plan", permissionMode: "plan", scope: "global" },
  { id: "auto", name: "Auto", permissionMode: "acceptEdits", scope: "global" },
  { id: "edit", name: "Edit", permissionMode: "default", scope: "global" },
];

export const MOCK_AGENTS: AgentConfig[] = [
  {
    id: "build",
    name: "Builder",
    instructions: "Principal engineer. Small, tested, conventional commits.",
    permissionMode: "default",
    effort: undefined,
    scope: "global",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    instructions: "Adversarial code reviewer. Roast, then suggest fixes.",
    permissionMode: "plan",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    effort: undefined,
    scope: "global",
  },
  {
    id: "sprite",
    name: "Sprite Artist",
    instructions: "Generate + iterate top-down sprites via the PIL pipeline.",
    permissionMode: "default",
    effort: undefined,
    scope: "project",
    projectId: "hivebreak",
  },
];

/* -------------------------------------------------------------------- chats */

export const CHAT_NECRO = "chat_necro";
export const CHAT_SETTINGS = "chat_settings";
export const CHAT_STEAM = "chat_steam";
export const CHAT_METRICS = "chat_metrics";
export const CHAT_SCRATCH = "chat_scratch";

export const MOCK_CHATS: Chat[] = [
  {
    id: CHAT_NECRO,
    projectId: "hivebreak",
    title: "Necromancer elite — wave-10 boss",
    sessionId: "sess_8fa21c",
    agentId: "sprite",
    modeId: "edit",
    effort: "high",
    worktrees: ["C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite"],
    prs: [{ number: 71, url: "#", branch: "feat/necromancer-elite", state: "open" }],
    status: "running",
    createdAt: ago(48),
    updatedAt: ago(0.2),
  },
  {
    id: CHAT_SETTINGS,
    projectId: "hivebreak",
    title: "Settings modal cleanup",
    sessionId: "sess_1b7d0e",
    agentId: "build",
    modeId: "plan",
    effort: "medium",
    worktrees: ["C:/Users/Michael/projects/zombie-worktrees/feat-settings-modal-cleanup"],
    prs: [],
    status: "awaiting-input",
    createdAt: ago(96),
    updatedAt: ago(3),
  },
  {
    id: CHAT_STEAM,
    projectId: "hivebreak",
    title: "Steam cloud save",
    sessionId: "sess_44aa19",
    agentId: "build",
    modeId: "auto",
    effort: "xhigh",
    worktrees: ["C:/Users/Michael/projects/zombie-worktrees/feat-steam-cloud-save"],
    prs: [],
    status: "running",
    createdAt: ago(120),
    updatedAt: ago(0.4),
  },
  {
    id: CHAT_METRICS,
    projectId: "hivebreak",
    title: "Metrics dashboard recap",
    sessionId: "sess_09f3b2",
    agentId: "build",
    modeId: "edit",
    effort: "medium",
    worktrees: [],
    prs: [{ number: 66, url: "#", branch: "feat/discord-rich-presence", state: "merged" }],
    status: "done",
    createdAt: ago(60 * 20),
    updatedAt: ago(180),
  },
  {
    id: CHAT_SCRATCH,
    projectId: "hivebreak",
    title: "Scratch — flow-field notes",
    agentId: "build",
    modeId: "plan",
    effort: "low",
    worktrees: [],
    prs: [],
    status: "idle",
    createdAt: ago(60 * 30),
    updatedAt: ago(60 * 6),
  },
];

/* -------------------------------------------------- transcript (necro chat) */

const md = [
  "I'll replace the wave-10 hive boss with a **Necromancer elite** that summons a rolling minion horde instead of one health bar. Plan:",
  "",
  "1. Disable the current `hive` boss spawn at `introWave: 10`.",
  "2. Add a `necromancer` to the `recurringElites` roster — barless, `MinionBoss` tag.",
  "3. Give it a `summon` on cooldown, capped by the archetype minion budget.",
  "",
  "Here's the config shape I'm adding — husks inherit the wave HP cap so endless scaling stays intact:",
  "",
  "```ts",
  "export const necromancer: EliteDef = {",
  "  id: 'necromancer',",
  "  tag: 'MinionBoss',        // barless horde elite",
  "  introWave: 10,",
  "  hp: 2200,",
  "  abilities: [",
  "    { kind: 'summon', cooldown: 6.5, count: 4, minion: 'husk', cap: 18 },",
  "    { kind: 'blink',  cooldown: 9.0, range: 320 },",
  "  ],",
  "};",
  "```",
].join("\n");

/** The necromancer chat's worktree root — file paths resolve against it. */
const WT_NECRO = "C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite";

/** `cat -n`-shaped output, so a Read fixture reports a real line range. */
function numbered(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `${from + i}\tsource line ${from + i}`).join("\n");
}

/** Expand a compact file-call spec into its tool_use + tool_result pair. */
function fileRun(
  chatId: string,
  calls: Array<{
    name: string;
    input: Record<string, unknown>;
    out?: string;
    ok?: boolean;
    ms?: number;
  }>,
): ChatMessage[] {
  return calls.flatMap((call, i) => [
    {
      kind: "tool_use",
      id: `f${i}`,
      chatId,
      ts: ago(6) + i,
      turn: 0,
      toolUseId: `t_file${i}`,
      name: call.name,
      input: call.input,
    },
    {
      kind: "tool_result",
      id: `f${i}r`,
      chatId,
      ts: ago(6) + i,
      turn: 0,
      toolUseId: `t_file${i}`,
      name: call.name,
      ok: call.ok ?? true,
      isError: call.ok === false ? true : undefined,
      durationMs: call.ms,
      content: call.out ?? "Applied 1 edit.",
    },
  ]);
}

export const MOCK_MESSAGES: Record<string, ChatMessage[]> = {
  [CHAT_NECRO]: [
    {
      kind: "user",
      id: "m1",
      chatId: CHAT_NECRO,
      ts: ago(11),
      turn: 0,
      text: "Replace the wave-10 hive boss with a necromancer that spawns a minion horde. Keep endless scaling intact. Here's the reference silhouette I sketched.",
      images: [
        {
          id: "img1",
          path: "sketch.png",
          mimeType: "image/png",
          alt: "necromancer silhouette sketch",
          width: 96,
          height: 96,
        },
      ],
      origin: "human",
      effort: "high",
    },
    {
      kind: "assistant",
      id: "m2",
      chatId: CHAT_NECRO,
      ts: ago(10),
      turn: 0,
      uuid: "u_2a",
      model: "claude-opus-4-8",
      thinking:
        "The hive boss is the sole phase owner via ai.ts — I must disable its spawn, not add a second mask writer. Minions should reuse the husk archetype and inherit healthScalingMax.",
      text: md,
    },
    {
      kind: "tool_use",
      id: "m3",
      chatId: CHAT_NECRO,
      ts: ago(9),
      turn: 0,
      toolUseId: "t_bash1",
      name: "Bash",
      input: {
        command: "rg -n \"introWave: 10\" packages/config/src/enemies",
        description: "Find the current wave-10 boss registration",
      },
    },
    {
      kind: "tool_result",
      id: "m4",
      chatId: CHAT_NECRO,
      ts: ago(9),
      turn: 0,
      toolUseId: "t_bash1",
      name: "Bash",
      ok: true,
      durationMs: 412,
      content:
        "packages/config/src/enemies/hive.ts:42:  introWave: 10,\npackages/config/src/enemies/index.ts:88:  hive,",
    },
    {
      kind: "tool_use",
      id: "m5",
      chatId: CHAT_NECRO,
      ts: ago(7),
      turn: 0,
      toolUseId: "t_chrome1",
      name: "mcp__chrome__navigate",
      server: "chrome",
      input: {
        url: "http://localhost:5173/?wiki#/enemies/hive",
        waitUntil: "networkidle",
      },
    },
    {
      kind: "tool_result",
      id: "m6",
      chatId: CHAT_NECRO,
      ts: ago(7),
      turn: 0,
      toolUseId: "t_chrome1",
      name: "mcp__chrome__navigate",
      ok: true,
      durationMs: 1840,
      content: {
        title: "Hivebreak — Content Wiki",
        url: "http://localhost:5173/?wiki#/enemies/hive",
        status: 200,
        screenshot: "captured (1440×900)",
      },
    },
    {
      kind: "tool_use",
      id: "m6b",
      chatId: CHAT_NECRO,
      ts: ago(3),
      turn: 0,
      toolUseId: "t_todo1",
      name: "TodoWrite",
      input: {
        todos: [
          {
            content: "Disable the current hive boss spawn at introWave 10",
            activeForm: "Disabling the hive boss spawn",
            status: "completed",
          },
          {
            content: "Add necromancer to the recurringElites roster (barless, MinionBoss)",
            activeForm: "Adding the necromancer to recurringElites",
            status: "in_progress",
          },
          {
            content: "Give it a summon ability capped by the minion budget",
            activeForm: "Wiring the summon ability",
            status: "pending",
          },
          {
            content: "Verify endless HP scaling stays intact (healthScalingMax)",
            activeForm: "Verifying endless HP scaling",
            status: "pending",
          },
        ],
      },
    },
    // A run of file work — the fixture for FileRunGroup. Deliberately mixed
    // (searches, reads, repeated edits to one file, a failure) because the row
    // type earns its keep on a LONG run, not on one tidy edit.
    ...fileRun(CHAT_NECRO, [
      { name: "Grep", input: { pattern: "recurringElites", path: "packages/config/src" }, out: "Found 3 files\npackages/config/src/enemies/index.ts\npackages/config/src/waves/elites.ts\npackages/config/src/waves/schedule.ts", ms: 240 },
      { name: "Read", input: { file_path: `${WT_NECRO}/packages/config/src/waves/elites.ts` }, out: numbered(1, 96), ms: 90 },
      { name: "Read", input: { file_path: `${WT_NECRO}/packages/config/src/enemies/hive.ts`, offset: 30, limit: 40 }, out: numbered(30, 40), ms: 74 },
      { name: "Edit", input: { file_path: `${WT_NECRO}/packages/config/src/enemies/hive.ts`, old_string: "  introWave: 10,\n  boss: true,", new_string: "  introWave: null,\n  boss: false,\n  supersededBy: 'necromancer'," }, ms: 130 },
      { name: "Edit", input: { file_path: `${WT_NECRO}/packages/config/src/enemies/hive.ts`, old_string: "  healthScalingMax: 4.0,", new_string: "  healthScalingMax: 4.0,\n  // moved to the necromancer's minion budget\n  minionCap: 0," }, ms: 118 },
      { name: "Write", input: { file_path: `${WT_NECRO}/packages/config/src/enemies/necromancer.ts`, content: Array.from({ length: 64 }, (_, i) => `line ${i}`).join("\n") }, ms: 210 },
      { name: "Edit", input: { file_path: `${WT_NECRO}/packages/config/src/waves/elites.ts`, old_string: "  hive,\n  wraith,", new_string: "  necromancer,\n  wraith," }, ms: 96 },
      { name: "Edit", input: { file_path: `${WT_NECRO}/packages/game/src/systems/ai.ts`, old_string: "const owner = phaseOwner(wave);", new_string: "const owner = phaseOwner(wave, { elites: true });" }, ok: false, out: "String to replace not found in file.", ms: 61 },
      { name: "Glob", input: { glob: "packages/**/*.test.ts" }, out: "a.test.ts\nb.test.ts\nc.test.ts\nd.test.ts\ne.test.ts\nf.test.ts\ng.test.ts", ms: 55 },
    ]),
    {
      kind: "permission",
      id: "m7",
      chatId: CHAT_NECRO,
      ts: ago(1),
      turn: 0,
      requestId: "perm_write_necro",
      toolName: "Write",
      displayName: "Write",
      title: "Write file",
      description: "packages/config/src/enemies/necromancer.ts",
      decision: "pending",
      input: {
        file_path: "packages/config/src/enemies/necromancer.ts",
        content: "export const necromancer: EliteDef = { … }",
      },
    },
  ],
  [CHAT_SETTINGS]: [
    {
      kind: "user",
      id: "s1",
      chatId: CHAT_SETTINGS,
      ts: ago(30),
      text: "Clean up the settings modal — the plan/edit mode toggle is misaligned and overflows on small viewports.",
      origin: "human",
    },
    {
      kind: "assistant",
      id: "s2",
      chatId: CHAT_SETTINGS,
      ts: ago(28),
      uuid: "u_s2",
      text: "I traced it to the mode toggle using raw `80vh` under the UI-scale zoom. I have two options for the fix — which do you prefer?",
    },
  ],
  [CHAT_STEAM]: [
    {
      kind: "user",
      id: "st1",
      chatId: CHAT_STEAM,
      ts: ago(20),
      text: "Wire up Steam Cloud auto-save for the run stash. Follow the SDK docs.",
      origin: "human",
    },
    {
      kind: "assistant",
      id: "st2",
      chatId: CHAT_STEAM,
      ts: ago(2),
      uuid: "u_st2",
      text: "Reading the Steamworks Remote Storage docs and mapping the stash serializer to `FileWrite`/`FileRead`. Setting up the quota check now.",
    },
    // Two peer turns, because they are the ONLY rows in the app whose whole
    // point is that they must not look like the row above them: a `user` turn
    // is the only input channel a session has, so an agent-sent message is
    // structurally identical to something the human typed and is told apart
    // purely by how it renders.
    {
      kind: "user",
      id: "st3",
      chatId: CHAT_STEAM,
      ts: ago(1),
      text: "Heads up — I merged the save-format change on #214, so rebase before you touch the serializer.",
      origin: "peer",
      peer: { chatId: CHAT_SETTINGS, title: "Save format v3", projectId: "hivebreak" },
    },
    {
      kind: "user",
      id: "st4",
      chatId: CHAT_STEAM,
      ts: ago(1),
      text: "Is the quota check going to need its own settings toggle, or can I assume it is always on?",
      origin: "peer",
      peer: {
        chatId: CHAT_SETTINGS,
        title: "Save format v3",
        projectId: "hivebreak",
        askId: "ask_7f3a",
      },
    },
  ],
};

/* --------------------------------------------------------- attention queue */

export const MOCK_ATTENTION: AttentionItem[] = [
  {
    id: "att_necro",
    chatId: CHAT_NECRO,
    kind: "permission",
    summary: "Necromancer elite — allow Write necromancer.ts?",
    projectId: "hivebreak",
    permissionRequestId: "perm_write_necro",
    createdAt: ago(1),
  },
  {
    id: "att_settings",
    chatId: CHAT_SETTINGS,
    kind: "question",
    summary: "Settings modal cleanup — pick a fix approach",
    projectId: "hivebreak",
    createdAt: ago(3),
  },
  {
    id: "att_metrics",
    chatId: CHAT_METRICS,
    kind: "done",
    summary: "Metrics dashboard recap — turn complete",
    projectId: "hivebreak",
    createdAt: ago(180),
  },
];

/* ---------------------------------------------------------------- runners */

export const MOCK_RUNNERS: RunnerInstance[] = [
  {
    id: "run_metrics",
    projectId: "hivebreak",
    chatId: CHAT_NECRO,
    worktreePath: "C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite",
    subAppId: "metrics-server",
    kind: "docker",
    pid: 24188,
    port: 8180,
    ports: [8180, 5532],
    url: "http://localhost:8180",
    usedDocker: true,
    status: "running",
    startedAt: ago(6),
  },
  {
    id: "run_game",
    projectId: "hivebreak",
    chatId: CHAT_NECRO,
    worktreePath: "C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite",
    subAppId: "game",
    kind: "process",
    pid: 30022,
    port: 5273,
    ports: [5273],
    url: "http://localhost:5273",
    status: "running",
    startedAt: ago(6),
  },
];

export const MOCK_RUNNER_LOGS: Record<string, { stream: "stdout" | "stderr"; line: string; ts: number }[]> = {
  run_metrics: [
    { stream: "stdout", line: "metrics-server  | Postgres ready on :5532", ts: ago(6) },
    { stream: "stdout", line: "metrics-server  | Fastify listening on http://0.0.0.0:8180", ts: ago(6) },
    { stream: "stdout", line: "metrics-server  | GET /api/matches 200 (14ms)", ts: ago(2) },
    { stream: "stdout", line: "metrics-server  | ingest: 1 match summary from host=necro", ts: ago(1) },
    { stream: "stderr", line: "metrics-server  | warn: game_mode NULL for match 8f21c", ts: ago(0.6) },
  ],
  run_game: [
    { stream: "stdout", line: "vite v6.4  ready in 512 ms", ts: ago(6) },
    { stream: "stdout", line: "  ➜  Local:   http://localhost:5273/", ts: ago(6) },
    { stream: "stdout", line: "hmr update /src/renderer/neonEntityRenderer.ts", ts: ago(0.5) },
  ],
};

/* ---------------------------------------------------------------- worktrees */

export const MOCK_WORKTREES: WorktreeInfo[] = [
  {
    path: "C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite",
    branch: "feat/necromancer-elite",
    head: "a1c9f42",
    base: "main",
    isDirty: true,
    ahead: 3,
    behind: 0,
    projectId: "hivebreak",
    chatId: CHAT_NECRO,
    createdAt: ago(46),
  },
];

/** Diff-vs-main stat line for the worktree panel (mock of GET /worktrees/diff). */
export const MOCK_WORKTREE_DIFF: Record<
  string,
  { additions: number; deletions: number; files: { path: string; add: number; del: number }[] }
> = {
  "C:/Users/Michael/projects/zombie-worktrees/feat-necromancer-elite": {
    additions: 12,
    deletions: 3,
    files: [
      { path: "packages/config/src/enemies/necromancer.ts", add: 9, del: 0 },
      { path: "packages/config/src/enemies/hive.ts", add: 1, del: 2 },
      { path: "packages/config/src/enemies/index.ts", add: 2, del: 1 },
    ],
  },
};

/* ------------------------------------------------------------- PRs + actions */

export const MOCK_PRS: PRInfo[] = [
  {
    number: 71,
    url: "https://github.com/dipduo/zombie/pull/71",
    title: "feat/necromancer-elite: replace wave-10 hive boss",
    state: "open",
    branch: "feat/necromancer-elite",
    baseBranch: "main",
    isDraft: false,
    repo: "dipduo/zombie",
    author: "michael",
    labels: [],
    additions: 12,
    deletions: 3,
    mergeable: true,
    mergeStateStatus: "BLOCKED",
    checks: [
      { name: "Build · Typecheck · Lint · Test", status: "in_progress", conclusion: null },
      { name: "Movement lag-regression guard", status: "completed", conclusion: "success" },
      { name: "Copilot review", status: "completed", conclusion: "action_required" },
    ],
    reviewThreads: [
      { id: "th1", isResolved: false, isOutdated: false, path: "necromancer.ts", line: 14, author: "copilot", body: "Consider clamping `count` to the minion cap here." },
      { id: "th2", isResolved: true, isOutdated: true, path: "hive.ts", line: 42, author: "copilot" },
    ],
    createdAt: new Date(ago(44)).toISOString(),
    updatedAt: new Date(ago(1)).toISOString(),
  },
  {
    number: 66,
    url: "https://github.com/dipduo/zombie/pull/66",
    title: "feat/discord rich presence",
    state: "merged",
    branch: "feat/discord-rich-presence",
    baseBranch: "main",
    isDraft: false,
    repo: "dipduo/zombie",
    author: "michael",
    additions: 214,
    deletions: 39,
    checks: [{ name: "Build · Typecheck · Lint · Test", status: "completed", conclusion: "success" }],
    createdAt: new Date(ago(60 * 26)).toISOString(),
    updatedAt: new Date(ago(60 * 22)).toISOString(),
  },
  {
    number: 64,
    url: "https://github.com/dipduo/zombie/pull/64",
    title: "fix(client): bullet tracers stop at pierce limit",
    state: "merged",
    branch: "fix/bullet-pierce-tracer",
    baseBranch: "main",
    isDraft: false,
    repo: "dipduo/zombie",
    author: "michael",
    additions: 47,
    deletions: 12,
    checks: [{ name: "Build · Typecheck · Lint · Test", status: "completed", conclusion: "success" }],
    createdAt: new Date(ago(60 * 40)).toISOString(),
    updatedAt: new Date(ago(60 * 36)).toISOString(),
  },
];

export const MOCK_WORKFLOW_RUNS: WorkflowRun[] = [
  {
    id: 90811,
    name: "CI",
    workflowName: "ci.yml",
    status: "in_progress",
    conclusion: null,
    event: "pull_request",
    headBranch: "feat/necromancer-elite",
    url: "#",
    createdAt: new Date(ago(1)).toISOString(),
  },
  {
    id: 90744,
    name: "auto-merge",
    workflowName: "auto-merge.yml",
    status: "completed",
    conclusion: "success",
    event: "schedule",
    headBranch: "main",
    url: "#",
    createdAt: new Date(ago(70)).toISOString(),
  },
];
