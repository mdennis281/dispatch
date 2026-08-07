/**
 * Rename-chat dialog — the modal entry point for retitling a chat (opened from
 * the sidebar row's edit icon). Two ways to set the title:
 *   1. Freeform — type whatever you want.
 *   2. AI-generate — regenerate a title from the chat's recent USER messages
 *      (assistant output is deliberately ignored server-side), then review/edit
 *      it in the field before saving.
 *
 * The AI path reuses the existing `regenerate-title` action: it persists +
 * broadcasts a `chat-update`, which lands back in the chats store; we watch the
 * live title and drop the result into the draft so the user can tweak it.
 */
import { useEffect, useRef, useState } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { stripTitleMarks } from "@dispatch/shared";
import { Modal, Field, TextInput } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { actions } from "../../lib/actions.js";
import { useChats } from "../../stores/chats.js";

/** How long we wait for an AI title before giving up on the spinner. */
const GENERATE_TIMEOUT_MS = 22_000;

export function RenameChatDialog({
  chatId,
  open,
  onClose,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
}) {
  const chat = useChats((s) => s.byId[chatId]);
  const [draft, setDraft] = useState("");
  const [generating, setGenerating] = useState(false);
  // The title at the moment we asked for a regeneration — used to detect when a
  // fresh one has streamed back (the store title changes off it).
  const baselineRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // (Re)seed the draft each time the dialog opens.
  useEffect(() => {
    if (open) {
      // Marks are stripped for editing: the field is a text box, and `**` in it
      // reads as a typo rather than as the accent it renders to. Typing them
      // back is still how you emphasize a hand-written title.
      setDraft(stripTitleMarks(chat?.title ?? ""));
      setGenerating(false);
      baselineRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When an AI generation lands (store title diverges from the baseline we
  // captured on click), pull it into the draft and stop the spinner.
  const liveTitle = chat?.title;
  useEffect(() => {
    if (!generating || baselineRef.current === null) return;
    if (liveTitle && liveTitle !== baselineRef.current) {
      setDraft(stripTitleMarks(liveTitle));
      setGenerating(false);
      baselineRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, [liveTitle, generating]);

  // Clear the timer if the dialog unmounts mid-generation.
  useEffect(() => () => void (timerRef.current && clearTimeout(timerRef.current)), []);

  if (!chat) return null;

  const generate = () => {
    if (generating) return;
    baselineRef.current = chat.title;
    setGenerating(true);
    actions.regenerateTitle(chatId);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setGenerating(false);
      baselineRef.current = null;
    }, GENERATE_TIMEOUT_MS);
  };

  const save = () => {
    const next = draft.trim();
    if (!next || next === chat.title) {
      onClose();
      return;
    }
    actions.setTitle(chatId, next);
    // Optimistic: reflect the rename immediately; the chat-update reconciles.
    useChats.getState().upsertChat({ ...chat, title: next });
    onClose();
  };

  const over = draft.trim().length > 35;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={440}
      icon={<Pencil />}
      title="Rename chat"
      description="Type a title, or generate one from your messages."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!draft.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Title"
          hint={
            over ? `${draft.trim().length} chars — aim for ≤35` : "**bold** takes the accent"
          }
        >
          <TextInput
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            placeholder="New chat"
          />
        </Field>
        <Button
          variant="subtle"
          size="md"
          onClick={generate}
          disabled={generating}
          leftIcon={generating ? <Spinner size={13} /> : <Sparkles />}
          className="w-full"
        >
          {generating ? "Generating…" : "Generate with AI"}
        </Button>
      </div>
    </Modal>
  );
}
