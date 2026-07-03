# Claude Agent SDK — pinned API reference (v0.3.199)

Ground truth for the whole build. Verified by reading
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.199, claudeCodeVersion 2.1.199).
Package is ESM (`"type": "module"`), entry `sdk.mjs`, types `sdk.d.ts`.
Peer deps: `@anthropic-ai/sdk >=0.93`, `@modelcontextprotocol/sdk ^1.29`, `zod ^4`.
The SDK spawns the Claude Code runtime as a **subprocess** (bundled per-platform binary via
optionalDependencies, e.g. `@anthropic-ai/claude-agent-sdk-win32-x64`). Budget one
process per live session.

## Entry point

```ts
function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;   // string = single-shot; AsyncIterable = streaming input
  options?: Options;
}): Query;

interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                 // streaming input only
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  // + per-MCP permission override, setMaxThinkingTokens (see effort), supportedModels/commands
}
```

**Streaming input mode** (our default for live chats): pass an `AsyncIterable<SDKUserMessage>`.
Keep yielding user messages into it to **steer mid-run**. `SDKUserMessage.priority` =
`'now' | 'next' | 'later'` and `shouldQuery?: boolean` (false = append to transcript without
starting a turn) are the primitives for the per-chat steering queue.

## Options (fields we use)

- `cwd?: string` — per-worktree working dir.
- `permissionMode?: PermissionMode` — see mode mapping below.
- `canUseTool?: CanUseTool` — permission callback (our permission cards). NOTE: tools listed in
  `allowedTools` are auto-allowed and **do not** invoke `canUseTool`.
- `allowedTools?: string[]`, `disallowedTools?: string[]` — tool gating.
- `agent?: string` + `agents?: Record<string, AgentDefinition>` — custom agents (our agents/modes).
- `systemPrompt?: string | string[] | { type:'preset', preset:'claude_code', append?... }` — custom instructions.
- `mcpServers?: Record<string, McpServerConfig>` — MCP passthrough (Claude-in-Chrome + others).
- `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` — Notification/Stop/etc.
- `model?: string`, `fallbackModel?`, `maxTurns?`, `maxBudgetUsd?` (USD cap).
- Session: `continue?: boolean` | `resume?: string` (session id) | `resumeSessionAt?: string` (msg uuid) | `forkSession?: boolean`.
- `includePartialMessages?: boolean` — emit `stream_event` deltas (token-level typing).
- `settingSources?: ('user'|'project'|'local')[]` — **default loads NONE**. Set to load repo/user
  settings + project MCP. Auth credentials load regardless of this.
- `abortController?: AbortController`, `stderr?: (s)=>void`, `env?`, `pathToClaudeCodeExecutable?`.

### Mode mapping (our UI → SDK)
- **plan** → `permissionMode: 'plan'` (read-only until it proposes; edits route to `canUseTool`).
- **edit** → `permissionMode: 'acceptEdits'` (auto-accept file edits, still prompt for risky).
- **auto** → `permissionMode: 'auto'` (model classifier approves/denies) or `'bypassPermissions'` (YOLO).
- **ask/default** → `permissionMode: 'default'` (prompt via `canUseTool`).

### Effort
`Query.setMaxThinkingTokens(n)` / thinking-token budget is the "effort" lever — see grep result
in this commit. Map effort low→max to thinking-token budgets.

## Permissions

```ts
type CanUseTool = (toolName: string, input: Record<string, unknown>, opts: {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];   // e.g. offer "always allow" → return as updatedPermissions
}) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## Messages (`SDKMessage` union — what the stream yields)

- `SDKSystemMessage` `{ type:'system', subtype:'init', session_id, model, tools[], mcp_servers[], permissionMode, apiKeySource }` — **capture `session_id` here**.
- `SDKAssistantMessage` `{ type:'assistant', message: BetaMessage, parent_tool_use_id, uuid, session_id, subagent_type? }` — `message.content[]` has `text` / `tool_use` / `thinking` blocks (render MCP cards from `tool_use` where name starts `mcp__`).
- `SDKUserMessage` `{ type:'user', message: MessageParam, priority?, shouldQuery?, origin? }`.
- `SDKPartialAssistantMessage` `{ type:'stream_event', event: BetaRawMessageStreamEvent }` — only when `includePartialMessages`.
- `SDKResultMessage` = success|error `{ type:'result', subtype, num_turns, is_error, result, duration_ms, usage/cost }` — **turn-done signal**.
- `SDKPermissionDenial`, `SDKMessageOrigin` (human/channel/peer).

## AgentDefinition
```ts
type AgentDefinition = {
  description: string;
  prompt: string;               // system prompt
  tools?: string[];             // allow-list (omit = inherit all)
  disallowedTools?: string[];
  model?: string;
  // + mcpServers, permissionMode, maxTurns, background (per-agent overrides)
};
```

## CONFIRMED by Phase 0 spikes (see `packages/server/spikes/`)

- **Subscription auth headless: WORKS.** `query()` runs on `~/.claude/.credentials.json` with
  no `ANTHROPIC_API_KEY` — init message reports `apiKeySource: 'none'`, model
  `claude-opus-4-8[1m]`. Do **not** set an API key.
- **Streaming input + mid-run steering: WORKS.** Feed the session an `AsyncIterable<SDKUserMessage>`.
  Pushing a 2nd user message after a `result` starts a 2nd turn — this is the steering primitive.
  Use the `InputChannel` push/close pattern from `spikes/streaming-input.ts` in SessionBroker.
- **`Query.interrupt()` available** in streaming input mode.
- **Permission model (IMPORTANT):** `canUseTool` is ONLY the "ask" path. Safe/in-scope actions
  (e.g. `Bash echo` inside `cwd`) auto-allow via rule/workingDir/safety and NEVER call `canUseTool`.
  Genuinely-gated actions (e.g. `Write`) DO call it. **ALLOW** (`{behavior:'allow',updatedInput}`)
  and **DENY** (`{behavior:'deny',message}`) both verified end-to-end. The callback's 3rd arg gives
  `displayName`/`title`/`description`/`decisionReason` — use for permission-card copy.
  → For UNIVERSAL tool visibility (show every call as a card, even auto-allowed), read `tool_use`
    blocks from the stream and/or a `PreToolUse` hook; only PROMPT on `canUseTool` invocations.
- **Concurrency: WORKS.** 3 sessions via `Promise.all`, distinct `session_id`s, all succeeded.
- **Effort lever:** `thinking?: ThinkingConfig` in Options (adaptive/enabled/disabled) supersedes
  deprecated `maxThinkingTokens`; live `Query.setMaxThinkingTokens(n, display?)`. Map UI effort → this.

## CONFIRMED — AskUserQuestion (live spike `spikes/ask-user-question.ts`)
Surfaces BOTH as a `tool_use` block (name `AskUserQuestion`, input `{ questions: [{ question,
header, options: [{ label, description, preview? }], multiSelect }] }`) in the assistant stream
AND as a `canUseTool("AskUserQuestion", input, …)` call. It does **not** route through
`onUserDialog` (the `request_user_dialog` / `permission_ask_user_question` dialog is only emitted
to a client that declares `supportedDialogKinds` and hasn't already answered over canUseTool).
**Answer it over `canUseTool`**: return the ALLOW result with an `answers` map (question text →
chosen label; multi-select = comma-joined labels; free text passes through) merged onto the
original input:
```ts
{ behavior: "allow", updatedInput: { ...input, answers: { [question]: label } } }
```
Omitting `answers` makes the CLI tool_result "The user did not answer the questions." (the model
gets a non-answer). With it: "Your questions have been answered: …" and the turn continues.
Broker surfaces the QuestionCard via the `canUseTool` → permission-request path and suppresses the
redundant `AskUserQuestion` tool_use row; `SessionBroker.answerQuestion` builds the `updatedInput`.

## Still open (non-blocking; validate during build)
- **Claude-in-Chrome MCP** — wire as an `mcpServers` entry; validate it drives real Chrome.
