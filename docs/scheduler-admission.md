# Scheduler admission: a real bound, and a queue that knows who waits on whom

## The problem this fixes

`maxActiveSessions` stopped being a bound in PR #258. That change made a chat
give up its slot while it is blocked (on `watch_pr`, a question card, a peer
chat, a sleep), so that six chats parked on CI could not pin the whole app at
its cap with zero tokens in flight. It was the right fix for that failure.

But release was admission-only. When the blocked call returned, the chat
resumed immediately without re-acquiring a slot — the code called it a
deliberate burst, on the grounds that a tool call cannot be paused mid-flight.
Every block-then-unblock cycle therefore leaked one slot, and nothing reclaimed
it. In a review-profile project every chat goes through `watch_pr` several
times per PR, so the running set converged on "everything that has ever been
admitted and has not finished": nine chats working under a cap of four, with
the human looking at a setting the app no longer honoured.

The deadlock #258 was written against had a different root cause that the
release did not address: ship chats blocked on reviewer chats that sat behind
unrelated cold starts in a FIFO queue. Making room papered over it. The queue
was still FIFO and still blind to dependencies.

## The two rules

### 1. Resuming re-acquires a slot

A tool call cannot be paused — but a tool RESULT can be held. Almost every
blocking tool is served by Dispatch itself (`watch_pr`, `wait`, `wait_for_chat`,
`chat_ask`, `ask_user`, `request_human_review`, `request_exemption`,
`secret_request`), and so are permission prompts and `AskUserQuestion` answers.
Dispatch controls the instant each of those answers reaches the model.

So, before a blocking manager tool returns, its handler asks the broker for a
slot (`SessionBroker.acquireSlot`). Before a permission prompt or question is
answered, `resolvePermission` does the same. If a slot is free the call returns
at once; otherwise the chat is parked in the admission queue as a RESUME entry
and the result is held until it is picked. The subprocess is already idle, so
the hold costs nothing. The chat's status stays turn-live (`waiting`) because
its turn IS still open — a message sent to it must steer, not start a new turn —
and the scheduler panel lists it under Queued with a "resuming" tag.

The gate is applied in one place for tools: `buildCategoryServer` wraps every
manager tool whose `classifyActivity` state is `blocked`-class. That is the same
classification the slot cap counts by, so "this tool frees a slot" and "this
tool re-acquires one" cannot drift apart — and a new blocking tool gets the gate
the moment it is classified (see `metrics-activity.ts`).

Hand-off: a granted slot is RESERVED on the session until the tracker sees it
occupied again. The tool result reaches the model asynchronously, and between
the grant and the model's next `generating` span the tracker still reads the
chat as blocked; without the reservation `drainQueue` would hand the same slot
to a second chat in that gap, which is precisely the burst this rule exists to
end.

Two refinements from review:

- **One entry per chat.** Two blocking calls returning together (a `watch_pr`
  and a `wait_for_chat` in one message) join the same `resume` entry; a second
  entry wedged the chat, because the first grant's reservation filled the cap
  and the second could never be granted. A resume whose chat already holds a
  slot (a subagent kept it, or a reservation is in place) is granted without a
  free slot — it is a held answer, not an admission.
- **Only a call that actually waited is gated.** `withSlotReacquire` lets a
  call that returned in under `SLOT_REACQUIRE_MIN_MS` (2s) through at once.
  `resolve_thread` takes 200ms; holding its result for a slot would convoy the
  chat behind whatever cold start was admitted in that window, at every quick
  GitHub or spawn call. The brief overshoot is the pre-#358 burst, and cheap.

Three things end a resume wait without a slot: the session aborting (stop,
fork, kill — the turn is being torn down), the global pause being lifted (which
re-pumps), and nothing else. A steering message does not grant; it promotes the
entry to the human tier (below).

What this does NOT bound: harness-native remote tools (`WebFetch`, `WebSearch`)
whose results Dispatch never touches. They last seconds. `Task`/`Agent` is not
affected either: the parent is blocked but its subagent is occupied on its own
actor, so the chat never gave its slot up.

### 2. The queue is tiered by who is waiting on whom

`drainQueue` no longer pops the head of a FIFO. Each pass it picks the entry
with the lowest TIER, oldest first within a tier:

| Tier | Who | Why first |
| --- | --- | --- |
| 0 | A resume whose wait a HUMAN answered — a permission, a question, a review card, a steer (`resolvePermission` is told `human: true` only by the UI routes; a timeout or a retired question is tier 2) | The person already waited for the agent once. Making them wait again for a slot would feel like the old deadlock in a new coat. |
| 1 | A chat another live, blocked chat is waiting ON — a reviewer whose PR a shipper is watching, a child a parent is in `wait_for_chat`/`chat_ask` on | Admitting it frees two chats, not one. This is priority inheritance, and the direct fix for the deadlock #258 described. |
| 2 | Any other resume | Its context is loaded and it is closer to finishing. Finishing in-flight work before starting new work is the WIP-limit principle; it is what keeps the queue from growing. |
| 3 | A cold start | Everything else. |

Tier is computed at PICK time, not at enqueue, because dependencies change:
the shipper that was watching a PR may have been steered away, and the parent
that was waiting on a child may have ended its turn.

Dependencies are declared, not inferred. `watch_pr` tells the broker the PR
number it is parked on; `wait_for_chat` and `chat_ask` name the chat
(`noteWaitingOn`), and the declaration is cleared when the call returns. A
reviewer is joined to the PR through `Chat.reviewOf`; a child to its parent
through `Chat.parentChatId`. A queued entry is tier 1 when some OTHER session is
turn-live, not occupied, and either waits on this chat's id, or waits on the PR
number this chat reviews.

### A blocked waiter lends its slot

Tier 1 alone was not enough. On the install this was built for, six chats
were generating under a cap of six for half an hour while two shippers sat in
`watch_pr` and their reviewers sat queued at tier 1. Tier 1 only helps when a
slot frees, and none did: each shipper had released its slot (rule from #258)
and cold starts had taken both. A pair that should cost one slot was costing
zero, and the reviewer could not run.

So a chat that a blocked, turn-live chat is waiting on is admitted even at a
full cap, as long as that waiter is not already lending to another running
dependent (`admissible` / `freeSponsorOf` in the broker). The waiter cannot use
the slot — it is parked on exactly this chat — so nothing new is spent. A free
slot is always taken before a loan, and only a chat that NEEDED the loan is
stamped `onLentSlot` and credited: load is counted net of those, so the
effective cap is `cap + dependents admitted on a loan`, never `cap + waiters`
(a dependent that got an ordinary slot would otherwise be credited twice, once
for the waiter's slot already released under #258). Two waiters on one chat
lend it one slot between them. The snapshot reports `lent` so the panel reads
"7/6 slots · 1 lent" instead of looking like a broken cap.

Starvation: a steady stream of resumes can hold cold starts off indefinitely.
Resumes are finite — every turn ends — and the panel shows the order, so this
is accepted rather than aged away.

## What changed where

- `packages/shared/src/scheduler.ts` — `queued` entries carry `kind`
  (`start` | `resume`) and `tier` so the panel can show them.
- `packages/server/src/services/session-broker.ts` — `queueOrder: string[]`
  becomes `queue: QueueEntry[]`; `acquireSlot`, `noteWaitingOn`, `holdsSlot`'s
  reservation, `tierOf`, and the pick in `drainQueue`. `resolvePermission` and
  the harness question path await a slot before answering.
- `packages/server/src/services/mcp/manager-mcp.ts` — `ManagerMcpBroker` gains
  `acquireSlot` and `noteWaitingOn`; `buildCategoryServer` wraps blocked-class
  tools; the three dependency-bearing tools declare their targets.
- `packages/client/src/components/layout/PausePopover.tsx` — queued rows say
  "resuming" / "starting" and show the tier's reason.
