# Dispatch harness architecture

Dispatch owns the durable conversation. Claude Code and Codex own provider-native
sessions underneath it. A chat stores `harness` beside its provider-native
`sessionId`; that pair must never be separated because native session ids are not
portable across providers.

## Configuration resolution

New chats resolve runtime settings in this order:

1. Explicit create-chat input.
2. Project `harness` override.
3. App Settings `harness.defaultHarness`.
4. Built-in default (`claude`).

Model and effort then resolve from explicit chat input followed by the selected
provider's app defaults. The settings modal owns:

- default provider;
- default model and reasoning effort per provider;
- per-chat context ceiling;
- aggregate active-chat context budget;
- auto-compaction and its reserve window.

## Runtime boundary

The neutral contract is `packages/server/src/harness/types.ts`. Adapters receive a
`HarnessSessionSpec` and emit `HarnessEvent` values. Provider-specific concepts
must remain below that boundary:

- process discovery and version selection;
- native thread/session RPCs;
- model catalogues and supported effort levels;
- permission/sandbox translation;
- native stream and tool item formats;
- account usage/rate-limit formats;
- MCP configuration syntax.

Dispatch policy remains above the boundary:

- workflow instructions and guard decisions;
- project instructions, memory, and skills;
- manager tools and their service bindings;
- transcript persistence and UI wire events;
- scheduling, attention, and context budgets.

## Cross-provider continuation

Switching providers retires the live native session, clears `sessionId`, and
starts the next turn on the target provider. Dispatch injects a bounded neutral
handoff made from recent user, assistant, tool-call, tool-result, and notice rows.
The handoff explicitly says that old tool processes and approvals are historical
and mutable state must be rechecked. The full Dispatch transcript remains intact.

This is continuation, not native resume: a Claude session cannot be resumed by
Codex and a Codex thread cannot be resumed by Claude.

## Dispatch services in Codex

Claude receives the manager MCP in-process. Codex receives the same manager MCP
implementation through a loopback Streamable HTTP bridge with a per-chat bearer
grant. The grant is revoked when the session stops or switches providers. Project
MCP servers are translated to Codex config keys, and project/bundled skills are
materialized under `.agents/skills` for Codex (Claude uses `.claude/skills`).

## Capability matrix

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Streaming/final text | Yes | Yes |
| Tool calls/results | Yes | Yes |
| Structured questions | Yes | Yes |
| Native compaction | Yes | Yes |
| Native fork/resume | Yes | Yes |
| Live model/effort/posture | Yes | Yes |
| Project MCP + manager tools | In-process | Streamable HTTP |
| Project skills | `.claude/skills` | `.agents/skills` |
| Every-tool approval hook | Yes | No; command/file/escalation asks only |
| Pre-tool workflow veto | Hard hook | Approval-time veto plus interrupt fallback |
| Dispatch-authored subagent definitions | Yes | Not yet mapped |
| Detailed context categories | Yes | Totals/window only |
| Continuous account limits | No | Yes |

The client reads adapter capabilities and hides unsupported controls rather than
showing controls that silently do nothing.

## Remaining abstraction debt

The production Codex path now runs through the neutral adapter. The mature Claude
path still executes through the broker's legacy direct Agent SDK loop. Moving it
onto `ClaudeHarness` is the remaining large structural cleanup, but it must first
preserve these Claude-only policy hooks in the neutral contract:

- agent working-directory enforcement;
- background-shell interception;
- observed per-subagent effort reporting;
- hard pre-tool workflow hooks;
- detailed context-category reads.

Other honest provider differences still needing product work:

- map Dispatch-authored subagent definitions onto Codex's native collaboration
  when the app-server exposes a stable per-thread configuration surface;
- add arbitrary MCP elicitation UI (Codex currently declines unknown forms so a
  thread cannot wedge indefinitely);
- surface the weaker Codex workflow-guard guarantee in the UI;
- make the conservative aggregate-budget reservation strategy configurable if
  teams need higher concurrency than the current safety-first default;
- add end-to-end browser coverage for Settings/provider switching in addition to
  the server adapter and broker tests.

## Verification

- Shared, server, and client TypeScript builds pass.
- Server suite: 62 files / 1,134 tests passed; client suite: 18 files / 219 tests passed.
- Dedicated neutral-broker and Codex control/config tests pass.
- A live local Codex `0.147.0-alpha.6.6` app-server smoke test discovered seven
  models, read account limits, opened a thread, streamed deltas, finalized the
  assistant row, reported a 258,400-token context window, and completed the turn.
