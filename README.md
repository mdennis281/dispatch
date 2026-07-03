# claude-manager

A local control plane for Claude Code agents: rich, concurrent multi-chat sessions,
git-worktree orchestration, a per-worktree subApp runner, and GitHub PR/Actions
visibility — built on the Claude Agent SDK. Runs entirely on your machine.

- **Chat is the crown jewel:** streaming, images, effort control, custom agents/modes with
  their own instructions + permissions, mid-run steering, beautiful MCP call cards,
  per-message code+conversation rollback, and an embedded Monaco preview/diff.
- **Workhorse concurrency:** 3+ chats running at once per project, with a global Attention
  Queue that tells you exactly which chat needs your input.
- **Projects → subApps:** one repo, many runnable subApps (e.g. game, metrics-server,
  studio-director), each launchable per worktree on offset ports.

> Status: under active construction (Phase 0). Architecture lives in the project plan.
