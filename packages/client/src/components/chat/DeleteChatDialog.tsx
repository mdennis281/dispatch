/**
 * Delete-chat confirmation — the ONE delete interaction, shared by the sidebar
 * row and the transcript header.
 *
 * The sidebar used to use a two-click inline confirm (trash → check/✕) while the
 * header used this modal. Two risk grammars for one irreversible act, and the
 * inline one was the weaker in the way that matters: it had nowhere to PUT a
 * failure, so a delete that the server rejected just silently reset the icons.
 * Inline confirm is right for reversible things; this isn't one.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { deleteChat } from "../../lib/actions.js";
import { useChats } from "../../stores/chats.js";
import { useAttention } from "../../stores/attention.js";

export function DeleteChatDialog({
  chatId,
  title,
  open,
  onClose,
}: {
  chatId: string;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (deleting) return;
    setError(null);
    onClose();
  };

  const run = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteChat(chatId);
      // Purge local state + move focus off the now-gone chat (deletion is
      // REST-only, so there's no bus event to drive these client stores).
      useAttention.getState().clearChat(chatId);
      useChats.getState().removeChat(chatId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      width={420}
      icon={<Trash2 />}
      title="Delete chat"
      description={title}
      footer={
        <>
          {error && (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          )}
          <Button variant="ghost" onClick={close} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete chat"}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-secondary">
        This permanently removes the transcript and stops any running turn. This
        can&rsquo;t be undone.
      </p>
    </Modal>
  );
}
