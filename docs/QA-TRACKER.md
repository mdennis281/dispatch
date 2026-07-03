# claude-manager — QA & delivery tracker

**GOAL (by morning):** a BUG-FREE UI, then use it to ship the 3 Hivebreak tasks as REAL PRs.
**Process:** fix batch (workflow/subagents) → PM verifies LIVE in Chrome (never trust "green" claims) → next batch → then drive the 3 tasks. Delegate everything; keep subagent output OUT of PM context; persist state HERE so it survives context compaction.

## ENV / run
- Backend: `pnpm -C claude-manager start` → http://127.0.0.1:4319 (default `.data`, Hivebreak seeded, subApps game/metrics-server/studio-director).
- After each fix batch: `pnpm -C claude-manager build` → kill whatever listens on 4319 → restart → reload the browser → RE-VERIFY every fix live.
- Data/worktrees are on Michael's machine; clean up test worktrees (`git worktree remove`) between rounds.

## BATCH 1 — core UI  — DONE, VERIFIED LIVE ✓ (dropdown portal, instant-create, Send, model selector, worktree detection multi+diff, AI auto-title "READY")
- [ ] Select/dropdown portal + flip (fixes modal + composer clipping; Effort=low..max, Mode incl Plan, Agent)
- [ ] DELETE New Chat modal → clicking "New chat" instant-creates w/ defaults
- [ ] Fix Send button (only Ctrl+Enter submitted)
- [ ] Model selector (Opus/Sonnet/Haiku); show MODEL, not confusing "No agent"
- [ ] Agent-created worktree DETECTION (multiple per chat, attach to the creating chat; session stays at repo root)
- [ ] AI auto-title from convo + regenerate button

## BATCH 2 — dead/stub controls — DONE ✓ (palette/settings/chat-menu/delete VERIFIED LIVE; image-annotation built (marker.js2+CROPRO) — DEEP-VERIFY in final sweep via file_upload)
- [ ] Settings gear — dead → real settings panel (webhook, maxActiveSessions, theme…)
- [ ] Command palette (⌘K) — dead → implement (or remove if not doing it)
- [ ] Chat "…" options menu — dead → rename / delete chat (no way to remove junk chats today)
- [ ] AUDIT client for ALL unwired buttons/no-op onClick/stubs; wire or remove each
- [ ] PR panel stale copy ("create a worktree first")
- [ ] IMAGE ANNOTATION: clicking an attached image opens a markup editor — crop, circle/rect/arrow, freehand pen, highlighter, color picker, brush width, eraser, undo/redo — then attach the annotated result. Use a library (tui-image-editor / marker.js / Fabric-based), don't hand-roll. Wire into the composer's image-attach flow (upload the edited PNG as the ImageRef).

## BATCH 3 — Actions + PRs — DONE ✓ VERIFIED LIVE (Actions=last-run-per-workflow + real dispatch form w/ parsed workflow_dispatch inputs+branch; global PR view shows all open project PRs w/ live checks+review+Merge/Hold; PR panel live status)
- [ ] GH Actions: default view = LAST RUN PER WORKFLOW (not the global chronological history); each workflow invokable/dispatch with branch + params/inputs
- [ ] PRs: live COMMENT status + BUILD/CHECKS status, clean layout
- [ ] GLOBAL project-wide PR list (all open PRs for the project, not only per-chat)

## BATCH 4 — capability gaps (QUEUED, after the 3 tasks or interleaved)
- [ ] BYPASS MODE BUG: setMode(bypassPermissions) fails — session not launched with --dangerously-skip-permissions. Broker must launch with allowDangerouslySkipPermissions:true so Bypass posture works (needed for autonomous task-running). FIXING NOW as a quick pre-step.
- [ ] SCREENSHOT-TO-UI (user request): the in-chat agent can screenshot a browser tab (via Claude-in-Chrome MCP) and push the image up into the chat transcript UI. Needs MCP passthrough of claude-in-chrome into sessions + image rendering from tool results in the transcript.
- [ ] IMAGE ANNOTATION deep-verify (from Batch 2) — hand-drive via file_upload / during the necromancer task.

## HIGH-PRI BUG (apply at next server rebuild, after Batch 5 lands)
- [ ] WORKTREE LIVE-SYNC: detector only fires on TURN-COMPLETE, so agent-created worktrees don't appear mid-turn (esp. long Bypass turns) — user sees "No worktrees yet" while the agent works. FIX: WorktreeDetector should ALSO poll every ~4s while a chat has an active/running session (and ideally detect right after a `git worktree`/`pnpm worktree` Bash tool call). No manual /refresh endpoint exists — optionally add GET/POST /api/worktrees/refresh + a panel Refresh button too. (User also suggested an MCP the agent calls to register worktrees.)

## BATCH 5 — user feature requests (QUEUED, implement + VISUALLY VERIFY each)
- [ ] CODE POINTERS: agent references to code render as clickable `file:path Lx-y` chips that open a Monaco preview scrolled to those lines ("oh it's here, file:x lines 69-96" → click → preview).
- [ ] SUBAGENTS/WORKFLOWS from a chat: the in-chat agent can spawn subagents + workflows; their chats are visualized as a NESTED menu under the parent chat (NOT flat in the sidebar).
- [ ] TODO PANEL: render the agent's TodoWrite/TaskCreate/TaskUpdate todo list in the UI per chat.
- [ ] FIX AskUserQuestion (QuestionCard) — "wasn't working last time"; make the question prompt round-trip work + visually verify.
- [ ] TOOLTIPS cut off: header-button tooltips AND modal-header tooltips (diff modal) are clipped — fix (portal/flip like the dropdown fix).
- [ ] DIFF MODAL side overview ruler: add a right-side scrollbar minimap with green/red diff markers (editor-style diff overview) so you can see where in the file the changes are. (User screenshot #4.)
- [ ] PERSISTENT TERMINAL SESSIONS: the agent's Bash cwd/env resets each call — provide persistent named terminal (PTY) sessions that keep cwd/env across commands, referenceable by the agent + visualized in the UI.
- [ ] BYPASS fix — DONE (allowDangerouslySkipPermissions). SCREENSHOT-TO-UI + IMAGE-ANNOTATION deep-verify still pending from Batch 4.

## HIGH-PRI BUG (add): WORKTREE ATTRIBUTION
- [ ] Detector attaches ALL newly-seen worktrees to whichever chat completes a turn FIRST (task 1 got tasks 2&3's worktrees). Attribute a worktree to the chat that CREATED it — match by branch (each task uses a distinct branch), or track which session ran the git-worktree command, or diff per-chat known-set at that chat's own turn-complete only.

## BATCH 6 — big capabilities (QUEUED)
- [ ] SUBAGENTS/WORKFLOWS from a chat + NESTED chat visualization under the parent (not flat sidebar).
- [ ] PERSISTENT TERMINAL SESSIONS (PTY; cwd/env persists; visualized).
- [ ] SCREENSHOT-TO-UI (agent screenshots a browser tab via Claude-in-Chrome MCP → renders in transcript).
- [ ] SCHEDULED CHECK-IN MCP (user request): agent can delay itself until a subagent completes or for a set duration (a wait/sleep-until tool).

## ACCEPTANCE: DONE ✓ — ALL 3 PRs shipped via the manager: #77 settings-modal-cleanup, #78 steam-cloud-save, #79 necromancer-elite. Full pipeline proven end-to-end.
## REPO: claude-manager is now its OWN git repo (baseline commit cd7a1be; node_modules/dist/.data gitignored). Overnight work is diffable/revertible.
## BATCH 5: FULLY VERIFIED LIVE (2026-07-03) ✓ — todos strip, header-button tooltip (no clip), modal-header tooltip "Inline diff" (no clip), diff overview ruler (green right-edge), Monaco diff+File/Diff+vs-main, code pointers (clickable `damage.ts:123-128` chips open preview), AskUserQuestion round-trip (card→Attention badge→answer→resume).
## IN PROGRESS: worktree↔chat + PR↔chat attribution SELF-HEAL (agent acd8c3bb9608f09b2). Root: worktrees created in the earlier buggy window got persisted under the WRONG chat (Settings owns necromancer #79 + steam #78); live-only rebuild never re-heals. FIX = reconstruct branch→chat from each chat's transcript history, rewrite chat.worktrees[] on reconcile (heals + survives restart), correlate PRs by branch. Expected: Settings→settings-modal-cleanup+#77, necro chat→necromancer-elite+#79, steam chat→steam-cloud-save+#78.
## BATCH 6: PAUSED (stopped mid-Feature-1 Checkin-MCP; WIP discarded to clean baseline). RESUME via Workflow({scriptPath: ".../workflows/scripts/cm-batch6-wf_266cc18d-a15.js", resumeFromRunId:"wf_266cc18d-a15"}) AFTER the attribution fix commits. Features: 1 scheduled-checkin MCP, 2 persistent terminals(PTY), 3 screenshot-to-UI, 4 subagents+nested viz, 5 integrate/review+unlink-worktree control.

## FINAL
- [ ] Full live re-verification (drive EVERY control with vision)
- [ ] Ship the 3 Hivebreak tasks through the UI → real PRs:
  1. `feat/settings-modal-cleanup`
  2. `feat/steam-cloud-save`
  3. `feat/necromancer-elite` — stronger wave-10 boss REPLACING the hive boss; do NOT spawn the old hive boss; involves images/sprites. Confirm spec w/ Michael when reached.

## KNOWN-GOOD (verified live): real chat loop, token streaming, permission cards + Attention Queue, worktree cwd isolation (clean worktree-first flow), persistence across restart, Apps/Runner panel, PRs base panel, LIVE GitHub Actions data.

## CONTEXT-MGMT NOTE
Michael warned: compact around 60–70% so I don't send gibberish. Mitigation: delegate to subagents (their output is summarized), read this tracker to re-anchor after any compaction, don't re-read large files.
