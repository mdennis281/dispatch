import {
  CHAT_DELETE_DAYS_MINIMUM,
  DEFAULT_CHAT_DELETE_DAYS,
  DEFAULT_MAX_CHATS_PER_PROJECT,
  DEFAULT_REVIEWER_CHAT_DAYS,
  DEFAULT_TOOL_IMAGE_DAYS,
  MAX_CHATS_PER_PROJECT_CEILING,
  RETENTION_DAYS_CEILING,
} from "@dispatch/shared";
import { Field, TextInput } from "../../sidebar/Modal.js";
import type { AppPaneProps } from "./types.js";

/** Digits only, and `undefined` for an empty box — blank means "the default",
 *  which for several of these fields is NOT the same answer as zero. */
function numberField(raw: string): number | undefined {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * How much history Dispatch loads, and how long it keeps.
 *
 * The section is split by that distinction and not by anything else, because it
 * is the only thing a reader needs to understand before typing a number here:
 * the first field changes what is on screen and nothing on disk, and the last
 * one deletes conversations. Grouping them by "they are all numbers about chats"
 * is how someone sets a load cap and loses a transcript.
 */
export function RetentionSection({ draft, patch }: AppPaneProps) {
  const r = draft.retention ?? {};
  const set = (p: Partial<typeof r>) => patch({ retention: { ...r, ...p } });
  const deleteDays = r.chatDeleteDays ?? DEFAULT_CHAT_DELETE_DAYS;

  return (
    <div className="space-y-3">
      {/* ------------------------------------------------------ what loads */}
      <div className="space-y-2 border-b border-line-soft pb-3">
        <Field
          label="Chats loaded per project"
          hint={`blank = ${DEFAULT_MAX_CHATS_PER_PROJECT}, 0 = all`}
          className="max-w-[12rem]"
        >
          <TextInput
            inputMode="numeric"
            value={r.maxChatsPerProject == null ? "" : String(r.maxChatsPerProject)}
            max={MAX_CHATS_PER_PROJECT_CEILING}
            onChange={(e) => set({ maxChatsPerProject: numberField(e.target.value) })}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          The newest chats of each project, by last activity. Nothing is deleted and nothing is
          hidden permanently — the rest stay on disk, the sidebar says how many there are and loads
          them when you ask, and a chat you open by link or find by search is fetched whether or not
          the cap reached it. A project can set its own number in its{" "}
          <code className="text-fg">project.yaml</code> under{" "}
          <code className="text-fg">retention.maxChatsPerProject</code>.
        </p>
      </div>

      {/* --------------------------------------------------- what is kept */}
      <div className="space-y-2 border-b border-line-soft pb-3">
        <Field
          label="Keep reviewer chats for"
          hint={`days after the PR settles — blank = ${DEFAULT_REVIEWER_CHAT_DAYS}`}
          className="max-w-[12rem]"
        >
          <TextInput
            inputMode="numeric"
            value={r.reviewerChatDays == null ? "" : String(r.reviewerChatDays)}
            max={RETENTION_DAYS_CEILING}
            onChange={(e) => set({ reviewerChatDays: numberField(e.target.value) })}
          />
        </Field>
        <Field
          label="Keep tool screenshots for"
          hint={`days — blank = ${DEFAULT_TOOL_IMAGE_DAYS}`}
          className="max-w-[12rem]"
        >
          <TextInput
            inputMode="numeric"
            value={r.toolImageDays == null ? "" : String(r.toolImageDays)}
            max={RETENTION_DAYS_CEILING}
            onChange={(e) => set({ toolImageDays: numberField(e.target.value) })}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          Both windows delete something DERIVED from a conversation, never the conversation: a
          reviewer chat once its findings are on GitHub, and images a tool returned. Images you
          attached yourself are never expired.
        </p>
      </div>

      {/* ------------------------------------------- what is deleted outright */}
      <div className="space-y-2">
        <Field
          label="Delete idle chats after"
          hint={`days — blank or 0 = never, minimum ${CHAT_DELETE_DAYS_MINIMUM}`}
          className="max-w-[12rem]"
        >
          <TextInput
            inputMode="numeric"
            value={r.chatDeleteDays == null ? "" : String(r.chatDeleteDays)}
            max={RETENTION_DAYS_CEILING}
            onChange={(e) => set({ chatDeleteDays: numberField(e.target.value) })}
          />
        </Field>
        {/* Warned at the point of setting it, not in the section blurb. This is
            the one field here that destroys a transcript, and the blurb is read
            once while the field is edited deliberately. */}
        <p className="text-xs leading-relaxed text-muted">
          {deleteDays > 0 ? (
            <>
              <span className="text-warn">
                Chats idle for {deleteDays} days will be deleted, with their transcripts.
              </span>{" "}
              Skipped while a chat is running, has an unmerged pull request, or still has a worktree
              on disk. A backlog drains over several passes rather than all at once.
            </>
          ) : (
            <>
              Off. Chats are never deleted for being old — the setting above only controls how many
              load at a time. Turn this on only if you want transcripts gone: once Claude Code&apos;s
              own session cleanup has run, Dispatch&apos;s copy is the only one.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
