/**
 * Deleting a chat, completely — the ONE path both `DELETE /api/chats/:id` and
 * the retention sweep go through.
 *
 * It lives outside the route because `store.deleteChat` on its own is a trap:
 * it removes the record and the transcript and leaves behind a live
 * subprocess, its shells, any browser shim it launched, attention items
 * pointing at a chat that no longer exists, checkpoint refs pinning commits in
 * the user's repository forever, and every other connected client still
 * showing the row. Each step below exists because one of those happened.
 */
import type { Services } from "./container.js";

/** What deleting a chat reaches into. */
export type ChatDeletionDeps = Pick<
  Services,
  | "store"
  | "bus"
  | "broker"
  | "attention"
  | "terminals"
  | "chatProcesses"
  | "processes"
  | "checkpoints"
>;

/**
 * Kill whatever OS processes are still attributed to a chat after its session
 * and shells have been stopped.
 */
export async function reapChatResidual(
  deps: Pick<ChatDeletionDeps, "chatProcesses" | "processes">,
  chatId: string,
): Promise<void> {
  const residual = await deps.chatProcesses.pidsFor(chatId);
  if (residual.length) await deps.processes.killPids(residual);
}

/** Stop, reap and forget a chat, then delete it and tell every client. */
export async function deleteChat(deps: ChatDeletionDeps, id: string): Promise<void> {
  const { store, bus, broker, attention, terminals, checkpoints } = deps;
  const existing = await store.getChat(id);
  // Tear the subprocess down, THEN forget the session so it can't leak.
  await broker.stop(id).catch(() => {});
  terminals.killChat(id);
  // A browser shim can outlive the provider that launched it. Reap while the
  // chat id still exists as an ownership key; after deletion the UI has no
  // row from which a human could recover the orphan.
  await reapChatResidual(deps, id).catch(() => {});
  broker.drop(id);
  // Authoritatively resolve every attention item this chat published — incl.
  // the "Session ended" one `stop()`→`onDone` just emitted — so no connected
  // client strands a phantom entry pointing at a now-deleted chat.
  for (const attId of attention.clearChat(id)) {
    bus.publish({ type: "attention-resolve", id: attId, chatId: id });
  }
  // BEFORE `deleteChat`, which drops the checkpoint rows — and those rows are
  // the only record of which worktrees this chat's refs live in. Without this
  // the refs (and the commits + trees they pin) stay in the user's repository
  // permanently: unreachable from any branch, but still referenced, so `git
  // gc` packs them instead of pruning and nothing ever reports them.
  //
  // The project's PRIMARY checkout is passed as the fallback and is not
  // optional: WorktreeReaper removes the worktree of a chat whose branch has
  // landed and leaves the chat behind, so for any chat deleted a while after
  // its work merged, every path its rows name is already gone. Refs are
  // shared repo-wide, so the primary checkout can always delete them.
  const owner = existing?.projectId
    ? await store.getProject(existing.projectId).catch(() => null)
    : null;
  await checkpoints.forget(id, owner?.repoPath).catch(() => {});
  await store.deleteChat(id);
  // Swept AGAIN, after the rows are gone. `forget` takes the per-chat lock,
  // so the first call already waited out any auto-checkpoint snapshot that
  // was mid-flight — but one that acquired the lock only after that call
  // released it writes its ref into a chat whose rows `deleteChat` has just
  // dropped, which is exactly the orphan nothing else can ever collect. The
  // second sweep costs one `for-each-ref` and finds nothing in the normal
  // case; it works off `repoPath` because the rows that named the worktrees
  // no longer exist.
  await checkpoints.forget(id, owner?.repoPath).catch(() => {});
  // Broadcast the deletion so EVERY client drops the chat (a second tab has no
  // other signal; the initiator's local purge only cleans itself).
  bus.publish({ type: "chat-deleted", chatId: id, projectId: existing?.projectId });
}
