# Dispatch

A local control plane for Claude Code agents: rich, concurrent multi-chat sessions,
git-worktree orchestration, a per-worktree subApp runner, and GitHub PR/Actions
visibility — built on the Claude Agent SDK. Runs entirely on your machine.

- **Chat is the crown jewel:** streaming, images, effort control, custom agents/modes with
  their own instructions + permissions, mid-run steering, beautiful MCP call cards,
  per-message code+conversation rollback, and an embedded Monaco preview/diff.
- **Workhorse concurrency:** 3+ chats running at once per project, with a global Attention
  Queue that tells you exactly which chat needs your input.
- **Projects → subApps:** one repo, many runnable subApps (e.g. game, metrics-server,
  studio-director), each launchable per branch/worktree on offset ports — with live logs
  and a ports/orphan reaper for the dev servers that outlive their runner.

See **[RUNNING.md](./RUNNING.md)** for setup, the UI walkthrough, and how to declare and
spin up dev-mode processes (subApps).
