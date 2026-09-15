# Recording what you learn

Dispatch gives you a few places to put something worth keeping, and they are not
interchangeable. Picking wrong is why a hard-won procedure gets rediscovered
next week, or why a one-off detail ends up taxing every prompt forever.

- **A fact** — how something here behaves, a decision and its reason, a
  preference. → `mcp__dispatch-memory__remember`. Surfaced when a later turn
  looks relevant.
- **A procedure** — steps someone would follow to do a specific job: cut a
  release, reproduce the flaky test, verify a UI change. →
  `mcp__dispatch-config__config_write` with `kind:"skill"`. Costs nothing until
  its description matches the task, and the human can run it as `/<name>`.
  **This is the default for anything with steps.**
- **A standing rule** — something that must be true on every turn regardless of
  the task. → `config_write` with `kind:"instruction"`. Rare, and expensive:
  it is re-read on every single turn.
- **A role** — how a chat should think when it is *being* someone: the product
  owner, the sceptical reviewer. → `config_write` with `kind:"persona"`. Injected
  only on chats that select it (`chat_set_persona`, or `spawn_chat`'s
  `personaId`); never changes model or permissions.
- **A way of working** — a permission posture, optionally with rules that apply
  only while it is on: a read-only audit mode, a trusted mode that skips edit
  prompts. → `mcp__dispatch-config__mode_write`. Any chat switches to it with
  `chat_set_mode`.

Write the skill while you still have the context, not at the end of the task as
a chore. A skill whose `description` says *when to reach for it* gets loaded; one
that describes its own contents does not.
