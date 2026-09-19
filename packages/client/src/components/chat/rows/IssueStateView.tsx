/**
 * The shared way an issue is DRAWN — one strip, one full panel — the issue
 * twin of `PrStateView`, and split the same way. The strip is what a
 * transcript row can afford: number, state, who opened it, its labels. The
 * panel is what the drilldown shows: the body, the thread, the assignees —
 * the things you open a card to actually read.
 *
 * The body and comments are rendered as MARKDOWN, quoted. In the tool result
 * they are fenced with a provenance line for the model's benefit; a person
 * scrolling the transcript wants to read the issue, not its fence, and the
 * quote-with-byline is the human form of the same warning: somebody else
 * wrote this.
 */
import { CircleCheck, CircleDot, ExternalLink, MessageSquare, User } from "lucide-react";
import type { Issue, IssueComment } from "@dispatch/shared";
import { Chip } from "../../ui/Chip.js";
import { Markdown } from "../Markdown.js";
import { cn } from "../../../lib/cn.js";
import { relTime } from "../../../lib/format.js";

/* ------------------------------------------------------------------ pieces */

export function IssueStateChip({ state }: { state: Issue["state"] }) {
  return state === "open" ? (
    <Chip tone="success" icon={<CircleDot />}>
      open
    </Chip>
  ) : (
    <Chip tone="agent" icon={<CircleCheck />}>
      closed
    </Chip>
  );
}

/** `@alice · owner` — who, and how far the repo trusts them. */
function Byline({ author, trust, bot }: { author: string; trust: string; bot?: boolean }) {
  return (
    <span className="cm-mono !text-2xs text-faint" title={`Author association: ${trust}`}>
      @{author}
      <span className="opacity-70">
        {" "}
        · {trust}
        {bot ? " · bot" : ""}
      </span>
    </span>
  );
}

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : relTime(t);
}

/* ------------------------------------------------------------------- strip */

/** The dense one-line state of an issue. Everything else is in the panel. */
export function IssueStateStrip({ issue }: { issue: Issue }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="cm-mono !text-2xs text-muted">#{issue.number}</span>
      <IssueStateChip state={issue.state} />
      <Byline author={issue.author} trust={issue.authorTrust} bot={issue.authorIsBot} />
      {issue.labels.map((l) => (
        <Chip key={l} tone="muted">
          {l}
        </Chip>
      ))}
      {issue.assignees.length > 0 && (
        <Chip tone="info" icon={<User />}>
          {issue.assignees.join(", ")}
        </Chip>
      )}
      {issue.commentCount > 0 && (
        <Chip tone="neutral" icon={<MessageSquare />}>
          {issue.commentCount}
        </Chip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-2xs font-medium uppercase tracking-wide text-faint">{title}</p>
      {children}
    </div>
  );
}

/** Somebody else's markdown, quoted with a byline. */
function Quoted({
  author,
  trust,
  at,
  body,
  url,
  highlight,
}: {
  author: string;
  trust: string;
  at?: string;
  body: string;
  url?: string;
  /** The comment this card is ABOUT (the one just posted) — drawn louder. */
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded border bg-inset px-2.5 py-2",
        highlight ? "border-accent-line" : "border-line",
      )}
    >
      <p className="flex items-center gap-2">
        <Byline author={author} trust={trust} />
        {at && <span className="cm-mono !text-2xs text-faint">{when(at)}</span>}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-faint hover:text-accent-hi"
            title="Open on the tracker"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </p>
      {body.trim() ? (
        <Markdown className="mt-1 !text-xs !text-secondary">{body}</Markdown>
      ) : (
        <p className="mt-1 text-xs italic text-faint">(empty)</p>
      )}
    </div>
  );
}

/**
 * The full picture of one issue: title, byline, strip, body, and the comments
 * the tool carried with it.
 *
 * `comments` is whatever the payload had — the window `issue_read` fetched, or
 * the single one `issue_comment` posted (flagged `posted`, so it is drawn as
 * the point of the card rather than as one more line of thread).
 */
export function IssueStatePanel({
  issue,
  comments = [],
  commentCount,
  posted,
}: {
  issue: Issue;
  comments?: IssueComment[];
  /** Total on the tracker, when `comments` is only a window of it. */
  commentCount?: number;
  /** Ids of comments this call created. */
  posted?: Set<string>;
}) {
  const total = commentCount ?? issue.commentCount;
  const shown = comments.length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          {issue.state === "open" ? (
            <CircleDot className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent-2-hi" />
          )}
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 text-sm font-medium leading-snug text-primary hover:text-accent-hi"
          >
            {issue.title}
          </a>
        </div>
        <p className="cm-mono !text-2xs text-faint">
          opened {when(issue.createdAt)} by @{issue.author}
          {issue.updatedAt && issue.updatedAt !== issue.createdAt ? ` · updated ${when(issue.updatedAt)}` : ""}
        </p>
        <IssueStateStrip issue={issue} />
      </div>

      <Section title="Body">
        <Quoted author={issue.author} trust={issue.authorTrust} body={issue.body} />
      </Section>

      <Section
        title={
          total === 0
            ? "Comments"
            : shown < total
              ? `Comments (latest ${shown} of ${total})`
              : `Comments (${total})`
        }
      >
        {shown === 0 ? (
          <p className="text-xs text-muted">
            {total === 0 ? "No comments yet." : `${total} on the tracker — none were read in this call.`}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {comments.map((c) => (
              <Quoted
                key={c.id}
                author={c.author}
                trust={c.authorTrust}
                at={c.createdAt}
                body={c.body}
                url={c.url}
                highlight={posted?.has(c.id)}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/** `issue_list`'s rows — the tracker's slice, as it was read. */
export function IssueListPanel({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return <p className="text-xs text-muted">No issues matched.</p>;
  return (
    <div className="flex flex-col">
      {issues.map((i) => (
        <a
          key={i.number}
          href={i.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-baseline gap-2 rounded px-1.5 py-1 text-xs text-secondary transition-colors hover:bg-hover/30"
        >
          <span className="w-12 shrink-0 cm-mono !text-2xs text-muted">#{i.number}</span>
          <span className="min-w-0 flex-1 truncate">{i.title}</span>
          <span className="flex shrink-0 items-center gap-1">
            {i.state === "closed" && <IssueStateChip state="closed" />}
            {i.labels.slice(0, 3).map((l) => (
              <Chip key={l} tone="muted">
                {l}
              </Chip>
            ))}
            {i.labels.length > 3 && <span className="text-2xs text-faint">+{i.labels.length - 3}</span>}
          </span>
          <Byline author={i.author} trust={i.authorTrust} />
        </a>
      ))}
    </div>
  );
}
