# Shipped instructions

Every `*.md` in this directory is injected into the system prompt of **every
session on every project**, on every turn, forever. It is delivered by an app
upgrade — this is the `shipped` scope in `services/authored-config.ts`.

That reach is the whole point and also the whole danger. Before adding a file
here, three questions:

1. **Is it true for every project?** A fact about *this* repo belongs in
   `.dispatch/instructions/`, not here. Anything mentioning `pnpm dev`, port
   4318/4319 or `packages/` is about Dispatch-the-repo and does not belong.
2. **Does it have to be always-on?** If the answer is "only when the task is
   X", it is a **skill** — put it in `packages/server/skills/<name>/SKILL.md`,
   where it costs nothing until its description matches. Skills are the default
   answer; an instruction is the exception.
3. **Is it already said?** `buildManagerToolsDirective` in
   `session-broker.ts` already introduces every `mcp__dispatch-*__*` tool the
   session has. Repeating it here pays for it twice.

This file is not injected: `readInstructionsDir` skips `README.md` by name, so
a config dir can document itself without charging every turn for the privilege.
Everything else here ships.
