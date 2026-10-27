import type { ReactNode } from "react";
import type { ToolUseRow } from "@dispatch/shared";
import { Markdown } from "../Markdown.js";
import { CodeBlock } from "../CodeBlock.js";
import { Chip } from "../../ui/Chip.js";
import { safeJson } from "../../../lib/format.js";

/** One memory as `recall` writes it back: `### name (type)[ — linked]\ndescription\n\nbody`. */
export interface RecalledMemory {
  name: string;
  type: string;
  linked: boolean;
  description: string;
  body: string;
}

export interface RecallResult {
  heading: string;
  memories: RecalledMemory[];
  /** The "N more omitted" footer the server adds when it hits its size budget. */
  tail?: string;
}

const HEAD = /^### (.+?) \((\w+)\)( — linked)?$/;

/**
 * Splits a `recall` result back into its memories so the inspector can give
 * each one its own section. The server joins them with `---` rules, and a
 * remembered body is markdown that may well contain its own `---` — so a chunk
 * only starts a new memory when it opens with the `### name (type)` head;
 * anything else is glued back onto the memory before it.
 *
 * Returns null for anything not in that shape (the index, "no matches", an
 * error) — those already read fine as plain markdown.
 */
export function parseRecallResult(text: string): RecallResult | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const first = normalized.indexOf("\n\n");
  if (first < 0) return null;
  const heading = normalized.slice(0, first);
  if (!/^\d+ match\(es\) for /.test(heading)) return null;

  const chunks = normalized.slice(first + 2).split("\n\n---\n\n");
  let tail: string | undefined;
  const lastChunk = chunks[chunks.length - 1];
  if (chunks.length > 1 && lastChunk !== undefined && /^_\d+ more match\(es\) omitted/.test(lastChunk)) {
    tail = chunks.pop();
  }

  const memories: RecalledMemory[] = [];
  for (const chunk of chunks) {
    const [headLine = "", ...rest] = chunk.split("\n");
    const head = HEAD.exec(headLine);
    const previous = memories[memories.length - 1];
    if (!head) {
      if (!previous) return null;
      previous.body += `\n\n---\n\n${chunk}`;
      continue;
    }
    const [description = "", ...bodyLines] = rest;
    memories.push({
      name: head[1]!,
      type: head[2]!,
      linked: Boolean(head[3]),
      description,
      body: bodyLines.join("\n").replace(/^\n+/, ""),
    });
  }
  return memories.length ? { heading, memories, tail } : null;
}

function RawArguments({ use }: { use: ToolUseRow }) {
  return (
    <details>
      <summary className="cursor-pointer select-none text-2xs text-faint hover:text-muted">Raw arguments</summary>
      <CodeBlock code={safeJson(use.input)} language="json" className="!my-1.5" />
    </details>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">{label}</div>
      {children}
    </div>
  );
}

function str(use: ToolUseRow, key: string): string | undefined {
  const value = use.input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The request pane for a memory call. A `remember` is a markdown document with
 * three bits of metadata; dumped as JSON its body becomes one long line of
 * `\n` escapes, which is the one part a reader actually wants to read.
 */
export function MemoryArguments({ use, tool }: { use: ToolUseRow; tool: string }) {
  const name = str(use, "name");
  const type = str(use, "type");
  const query = str(use, "query");
  const description = str(use, "description");
  const body = str(use, "body");
  return (
    <div className="space-y-3">
      {(name || type || query) && (
        <div className="flex flex-wrap gap-1">
          {name && <Chip tone="agent" mono>{name}</Chip>}
          {query && <Chip tone="muted" mono>query: {query}</Chip>}
          {type && <Chip tone="muted">{type}</Chip>}
        </div>
      )}
      {description && (
        <Field label="Description">
          <p className="text-sm text-secondary">{description}</p>
        </Field>
      )}
      {body && (
        <Field label="Body">
          <div className="rounded-md border border-line bg-surface px-3 py-2">
            <Markdown className="!text-sm !text-secondary">{body}</Markdown>
          </div>
        </Field>
      )}
      {!name && !query && !body && (
        <span className="text-xs text-faint">{tool === "recall" ? "No query — the whole index." : "No arguments."}</span>
      )}
      <RawArguments use={use} />
    </div>
  );
}

/** A `recall` result as one section per memory, each body rendered as the markdown it was saved as. */
export function RecallResultView({ result }: { result: RecallResult }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">{result.heading.replace(/:$/, "")}</div>
      {result.memories.map((m) => (
        <section key={m.name} className="rounded-md border border-line bg-surface">
          <header className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            <Chip tone="agent" mono>{m.name}</Chip>
            <Chip tone="muted">{m.type}</Chip>
            {m.linked && <Chip tone="muted">linked</Chip>}
            {m.description && <span className="min-w-0 basis-full text-xs text-muted">{m.description}</span>}
          </header>
          <div className="px-3 py-2">
            <Markdown className="!text-sm !text-secondary">{m.body}</Markdown>
          </div>
        </section>
      ))}
      {result.tail && <Markdown className="!text-xs !text-faint">{result.tail}</Markdown>}
    </div>
  );
}
