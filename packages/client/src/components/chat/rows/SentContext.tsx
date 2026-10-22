/**
 * "Show sent context", made to show ALL of it.
 *
 * Until this existed the toggle disclosed surfaced memories and a sweep's repo
 * snapshot — a few hundred characters per turn — while the system-prompt append
 * (workflow contract, MCP capability map, house rules, every instruction file,
 * the memory catalogue), the MCP servers and the skills went unshown. Those are
 * the bulk of a 55k-token baseline, so the toggle read as "this is everything"
 * while hiding nearly all of it.
 *
 * Two surfaces share one vocabulary:
 *
 *   - {@link SentContextCard} hangs off the session's `init` row: one ellipsised
 *     line per section, server group and skill list, each with its size.
 *   - {@link ContextLine} is the same line for a turn's own `context` parts.
 *
 * Every line opens {@link ContextViewerModal}, where the full text lives. The
 * lines are deliberately ONE row each — at 15 sections an inline expander turns
 * the transcript into the system prompt, which is the opposite of auditable.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpen,
  Boxes,
  ChevronRight,
  Gauge,
  Layers,
  Plug,
  Sparkles,
} from "lucide-react";
import {
  readSentContext,
  type ContextUsage,
  type MessagePart,
  type SentContext,
  type SentContextMcpServer,
  type SystemMessageRow,
} from "@dispatch/shared";
import { api } from "../../../lib/api.js";
import { cn } from "../../../lib/cn.js";
import { Modal } from "../../sidebar/Modal.js";
import { RowButton } from "../../ui/RowButton.js";
import { Spinner } from "../../ui/Spinner.js";
import { CopyButton } from "./AuthoredCard.js";

/* ------------------------------------------------------------------ sizes */

/**
 * Rough token count for a block of prose: ~4 chars a token. Labelled "≈"
 * wherever it is shown — the exact number is the runtime's, and the live
 * breakdown in the modal is where it lives.
 */
function approxTokens(chars: number): string {
  const t = Math.round(chars / 4);
  return t >= 1_000 ? `≈${(t / 1_000).toFixed(1)}k tok` : `≈${t} tok`;
}

function fmtTokens(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));
}

/**
 * The first line worth showing. Prose beats headings: nearly every section
 * opens with a heading that merely restates its label, so a preview of it would
 * say the same thing twice and nothing about the contents.
 */
function previewOf(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[-_*]{3,}$/.test(l) && !/^<\/?[\w-]+>$/.test(l));
  const prose = lines.find((l) => !l.startsWith("#"));
  return (prose ?? lines[0] ?? "").replace(/^#+\s*/, "").replace(/^_(.*)_$/, "$1");
}

/* -------------------------------------------------------------- the line */

/**
 * One disclosure, one line: label, an ellipsised preview, its size. The whole
 * line is the target; detail is a modal away, never inline.
 */
export function ContextLine({
  icon,
  label,
  preview,
  size,
  onOpen,
}: {
  icon?: ReactNode;
  label: string;
  preview?: string;
  size?: string;
  onOpen: () => void;
}) {
  return (
    <RowButton
      onClick={onOpen}
      title={`${label} — open`}
      className={cn(
        "group flex w-full min-w-0 items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-2xs text-faint",
        "hover:bg-hover hover:text-muted [&_svg]:size-3 [&_svg]:shrink-0",
      )}
    >
      <ChevronRight className="opacity-50 transition-transform group-hover:translate-x-px" />
      {icon}
      <span className="max-w-[45%] shrink-0 truncate font-medium text-muted">{label}</span>
      {preview && <span className="min-w-0 flex-1 truncate opacity-80">{preview}</span>}
      {!preview && <span className="flex-1" />}
      {size && <span className="ml-2 shrink-0 cm-mono !text-2xs opacity-70">{size}</span>}
    </RowButton>
  );
}

/* ------------------------------------------------------------- the modal */

export interface ContextItem {
  key: string;
  /** Nav group heading ("System prompt", "Tools", "This turn"). */
  group: string;
  label: string;
  icon?: ReactNode;
  /** Right-aligned size note in the nav. */
  size?: string;
  /** Plain text to show and copy. Absent for structured items. */
  text?: string;
  /** Structured body, for items that aren't a block of text. */
  render?: () => ReactNode;
}

/**
 * The drill-down: every item down the left, the chosen one in full on the
 * right. One modal for the whole session's context rather than one per line,
 * because the question is usually "where did the window go" — and that is a
 * comparison across sections, not a read of one.
 */
export function ContextViewerModal({
  open,
  onClose,
  title,
  description,
  items,
  initialKey,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  items: ContextItem[];
  initialKey?: string;
  /** True while the full (unclipped) texts are still being fetched. */
  loading?: boolean;
}) {
  const [key, setKey] = useState(initialKey);
  useEffect(() => {
    if (open) setKey(initialKey);
  }, [open, initialKey]);
  const current = items.find((i) => i.key === key) ?? items[0];
  const groups = useMemo(() => {
    const out: { group: string; items: ContextItem[] }[] = [];
    for (const item of items) {
      const g = out.find((x) => x.group === item.group);
      if (g) g.items.push(item);
      else out.push({ group: item.group, items: [item] });
    }
    return out;
  }, [items]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      icon={<Sparkles />}
      width={1080}
    >
      <div className="flex min-h-[50vh] flex-col gap-3 sm:flex-row">
        <nav
          aria-label="Sent context sections"
          className="cm-scroll flex shrink-0 flex-col gap-2 sm:sticky sm:top-0 sm:max-h-[64vh] sm:w-64 sm:self-start sm:overflow-y-auto"
        >
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-2 pb-0.5 text-2xs font-medium uppercase tracking-[0.07em] text-faint">
                {g.group}
              </div>
              {g.items.map((item) => (
                <RowButton
                  key={item.key}
                  onClick={() => setKey(item.key)}
                  aria-current={item.key === current?.key || undefined}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-1.5 rounded-[5px] px-2 py-1 text-xs [&_svg]:size-3 [&_svg]:shrink-0",
                    item.key === current?.key
                      ? "bg-active text-primary"
                      : "text-muted hover:bg-hover hover:text-secondary",
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.size && (
                    <span className="shrink-0 cm-mono !text-2xs text-faint">{item.size}</span>
                  )}
                </RowButton>
              ))}
            </div>
          ))}
        </nav>
        <section className="min-w-0 flex-1">
          {current && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                  {current.label}
                </h3>
                {current.size && (
                  <span className="shrink-0 cm-mono !text-2xs text-faint">{current.size}</span>
                )}
                {current.text !== undefined && (
                  <CopyButton text={current.text} title="Copy this section" />
                )}
              </div>
              {current.render ? (
                current.render()
              ) : (
                <pre className="cm-mono whitespace-pre-wrap break-words rounded-md border border-dashed border-line-soft bg-inset px-3 py-2.5 !text-xs leading-[1.55] text-secondary">
                  {current.text}
                  {loading && (
                    <span className="mt-2 flex items-center gap-1.5 text-faint">
                      <Spinner /> loading the full text…
                    </span>
                  )}
                </pre>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------- a turn's context parts */

/**
 * A user row's `context` parts: one line each, all of them in the modal so a
 * turn with memories AND an attachment note can be read side by side.
 */
export function TurnContextLines({ parts }: { parts: MessagePart[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const items: ContextItem[] = parts.map((p, i) => ({
    key: `part:${i}`,
    group: "Attached to this turn",
    label: p.label ?? "context",
    icon: <Sparkles />,
    size: approxTokens(p.text.length),
    text: p.text,
  }));
  return (
    <div className="mt-1.5 w-full rounded-[5px] border border-dashed border-line-soft py-0.5 text-left first:mt-0">
      {items.map((item, i) => (
        <ContextLine
          key={item.key}
          icon={<Sparkles className="opacity-70" />}
          label={item.label}
          preview={previewOf(parts[i]!.text)}
          size={item.size}
          onOpen={() => setOpenKey(item.key)}
        />
      ))}
      <ContextViewerModal
        open={openKey !== null}
        onClose={() => setOpenKey(null)}
        title="Attached by Dispatch"
        description="Sent to the agent with this message — not typed by you"
        items={items}
        initialKey={openKey ?? undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------ session context */

const ORIGIN_LABEL: Record<SentContextMcpServer["origin"], string> = {
  dispatch: "Dispatch",
  bundled: "Bundled",
  project: "Project",
};

function McpServersBody({
  servers,
  usage,
}: {
  servers: SentContextMcpServer[];
  usage: ContextUsage | null | undefined;
}) {
  const tokensByServer = new Map<string, number>();
  const tokensByTool = new Map<string, number>();
  for (const t of usage?.mcpTools ?? []) {
    tokensByServer.set(t.serverName, (tokensByServer.get(t.serverName) ?? 0) + t.tokens);
    tokensByTool.set(t.name, t.tokens);
  }
  return (
    <div className="flex flex-col gap-2">
      {!usage?.mcpTools && (
        <p className="text-xs text-faint">
          Per-tool token counts come from the live session — open “Token breakdown” while the chat
          is running to load them.
        </p>
      )}
      {servers.map((s) => (
        <details key={s.name} className="rounded-md border border-line-soft bg-inset">
          <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs">
            <Plug className="size-3 shrink-0 text-faint" />
            <span className="min-w-0 truncate font-medium text-primary">{s.name}</span>
            <span className="shrink-0 rounded-[4px] bg-hover px-1 text-2xs text-muted">
              {ORIGIN_LABEL[s.origin] ?? s.origin}
            </span>
            <span className="shrink-0 text-2xs text-faint">{s.transport}</span>
            {s.status && s.status !== "connected" && (
              <span className="shrink-0 text-2xs text-warn">{s.status}</span>
            )}
            <span className="ml-auto shrink-0 cm-mono !text-2xs text-faint">
              {s.tools ? `${s.tools.length} tools` : "tools not reported"}
              {tokensByServer.has(s.name) && ` · ${fmtTokens(tokensByServer.get(s.name)!)} tok`}
            </span>
          </summary>
          {s.tools && s.tools.length > 0 && (
            <ul className="cm-mono grid grid-cols-1 gap-x-4 px-2.5 pb-2 pt-0.5 !text-2xs text-muted sm:grid-cols-2">
              {s.tools.map((t) => {
                const full = `mcp__${s.name}__${t}`;
                return (
                  <li key={t} className="flex min-w-0 gap-2">
                    <span className="min-w-0 truncate" title={full}>
                      {t}
                    </span>
                    {tokensByTool.has(full) && (
                      <span className="ml-auto shrink-0 text-faint">
                        {fmtTokens(tokensByTool.get(full)!)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      ))}
    </div>
  );
}

function BreakdownTable({ rows }: { rows: { name: string; tokens: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((r) => (
        <li key={r.name} className="flex items-center gap-2 text-xs">
          <span className="w-56 min-w-0 shrink-0 truncate text-muted" title={r.name}>
            {r.name}
          </span>
          <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-accent/70"
              style={{ width: `${(r.tokens / max) * 100}%` }}
            />
          </span>
          <span className="w-14 shrink-0 text-right cm-mono !text-2xs text-secondary">
            {fmtTokens(r.tokens)}
          </span>
          {r.note && <span className="shrink-0 text-2xs text-faint">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function UsageBody({ usage }: { usage: ContextUsage | null | undefined }) {
  if (usage === undefined) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-faint">
        <Spinner /> asking the runtime…
      </p>
    );
  }
  if (!usage) {
    return (
      <p className="text-xs text-faint">
        The session isn’t live in this server process, so the runtime can’t be asked. Send a message
        (or reopen the chat while it runs) and this fills in.
      </p>
    );
  }
  const byServer = new Map<string, number>();
  for (const t of usage.mcpTools ?? []) {
    byServer.set(t.serverName, (byServer.get(t.serverName) ?? 0) + t.tokens);
  }
  const block = (title: string, body: ReactNode) => (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 text-2xs font-medium uppercase tracking-[0.07em] text-faint">{title}</div>
      {body}
    </div>
  );
  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        <span className="cm-mono text-primary">{fmtTokens(usage.totalTokens)}</span> of{" "}
        <span className="cm-mono">{fmtTokens(usage.maxTokens)}</span> tokens in the window right now
        {usage.model && <> · {usage.model}</>}. Exact counts from the runtime, not estimates.
      </p>
      {usage.categories.length > 0 &&
        block(
          "By category",
          <BreakdownTable
            rows={[...usage.categories]
              .filter((c) => c.tokens > 0)
              .sort((a, b) => b.tokens - a.tokens)}
          />,
        )}
      {byServer.size > 0 &&
        block(
          "MCP tools by server",
          <BreakdownTable
            rows={[...byServer.entries()]
              .map(([name, tokens]) => ({ name, tokens }))
              .sort((a, b) => b.tokens - a.tokens)}
          />,
        )}
      {!!usage.systemPromptSections?.length &&
        block(
          "System prompt sections",
          <BreakdownTable
            rows={[...usage.systemPromptSections].sort((a, b) => b.tokens - a.tokens)}
          />,
        )}
      {!!usage.memoryFiles?.length &&
        block(
          "Memory files (CLAUDE.md…)",
          <BreakdownTable
            rows={usage.memoryFiles.map((m) => ({ name: m.path, tokens: m.tokens, note: m.type }))}
          />,
        )}
      {usage.skills &&
        block(
          `Skills — ${usage.skills.includedSkills} of ${usage.skills.totalSkills} listed`,
          <BreakdownTable
            rows={(usage.skills.skillFrontmatter ?? [])
              .map((s) => ({ name: s.name, tokens: s.tokens, note: s.source }))
              .sort((a, b) => b.tokens - a.tokens)}
          />,
        )}
      {!!usage.systemTools?.length &&
        block(
          "Built-in tools",
          <BreakdownTable rows={[...usage.systemTools].sort((a, b) => b.tokens - a.tokens)} />,
        )}
    </div>
  );
}

/**
 * The session's sent context, under its "Session started" marker.
 *
 * The row on the wire is LEAN — section texts are 240-char previews (see
 * `transcript-lean.ts`) — so the modal fetches the verbatim row once on open
 * and swaps the full texts in. Fetched into local state rather than through
 * `hydrateFullRows`: nothing else renders these texts, and replacing the row
 * in the store would re-render the transcript around a modal for no reader.
 */
export function SentContextCard({ row, sent }: { row: SystemMessageRow; sent: SentContext }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [full, setFull] = useState<SentContext | null>(sent.clipped ? null : sent);
  const [loadingFull, setLoadingFull] = useState(false);
  // undefined = not asked yet / in flight, null = session not live.
  const [usage, setUsage] = useState<ContextUsage | null | undefined>(undefined);
  const [askedUsage, setAskedUsage] = useState(false);

  const open = openKey !== null;
  useEffect(() => {
    if (!open || full) return;
    let cancelled = false;
    setLoadingFull(true);
    api.chats
      .messagesFull(row.chatId, [row.id])
      .then((rows) => {
        const got = readSentContext((rows[0] as SystemMessageRow | undefined)?.data);
        if (!cancelled && got) setFull(got);
      })
      .catch(() => {
        /* the previews stay; reopening retries */
      })
      .finally(() => !cancelled && setLoadingFull(false));
    return () => {
      cancelled = true;
    };
  }, [open, full, row.chatId, row.id]);

  // Asked on first open of ANY item, not only the usage one: the MCP view
  // shows per-tool tokens from the same answer, and one request is cheap.
  useEffect(() => {
    if (!open || askedUsage) return;
    setAskedUsage(true);
    api.chats
      .contextUsage(row.chatId)
      .then((r) => setUsage(r.usage))
      .catch(() => setUsage(null));
  }, [open, askedUsage, row.chatId]);

  const shown = full ?? sent;
  const totalChars = sent.sections.reduce((n, s) => n + s.chars, 0);
  const toolCount = sent.mcpServers.reduce((n, s) => n + (s.tools?.length ?? 0), 0);
  const anyTools = sent.mcpServers.some((s) => s.tools);

  const items: ContextItem[] = [
    ...shown.sections.map(
      (s, i): ContextItem => ({
        key: `section:${i}`,
        group: "System prompt (appended by Dispatch)",
        label: s.label,
        icon: <Layers />,
        size: approxTokens(s.chars),
        text: s.text,
      }),
    ),
    {
      key: "mcp",
      group: "Attached to the session",
      label: `MCP servers (${shown.mcpServers.length})`,
      icon: <Plug />,
      size: anyTools ? `${toolCount} tools` : undefined,
      render: () => <McpServersBody servers={shown.mcpServers} usage={usage} />,
    },
    ...(shown.skills.length
      ? [
          {
            key: "skills",
            group: "Attached to the session",
            label: `Skills (${shown.skills.length})`,
            icon: <BookOpen />,
            text: shown.skills
              .map((s) => (s.description ? `${s.name} — ${s.description}` : s.name))
              .join("\n"),
          } satisfies ContextItem,
        ]
      : []),
    {
      key: "usage",
      group: "Live",
      label: "Token breakdown",
      icon: <Gauge />,
      render: () => <UsageBody usage={usage} />,
    },
  ];

  return (
    <div className="px-4 pb-1.5">
      <div className="ml-7 rounded-[5px] border border-dashed border-line-soft py-0.5">
        <RowButton
          onClick={() => setOpenKey(items[0]?.key ?? "usage")}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-2xs text-faint hover:text-muted [&_svg]:size-3"
        >
          <Sparkles className="shrink-0 opacity-70" />
          <span className="shrink-0 uppercase tracking-[0.06em]">sent by Dispatch at session start</span>
          <span className="min-w-0 truncate">
            · {sent.sections.length} prompt sections · {approxTokens(totalChars)} ·{" "}
            {sent.mcpServers.length} MCP servers
            {anyTools && ` / ${toolCount} tools`}
            {sent.skills.length > 0 && ` · ${sent.skills.length} skills`}
          </span>
          <span className="ml-auto shrink-0 text-accent-2 opacity-80">Open all</span>
        </RowButton>
        {sent.sections.map((s, i) => (
          <ContextLine
            key={`section:${i}`}
            icon={<Layers className="opacity-70" />}
            label={s.label}
            preview={previewOf(s.text)}
            size={approxTokens(s.chars)}
            onOpen={() => setOpenKey(`section:${i}`)}
          />
        ))}
        <ContextLine
          icon={<Plug className="opacity-70" />}
          label={`MCP servers (${sent.mcpServers.length})`}
          preview={sent.mcpServers.map((s) => s.name).join(" · ")}
          size={anyTools ? `${toolCount} tools` : undefined}
          onOpen={() => setOpenKey("mcp")}
        />
        {sent.skills.length > 0 && (
          <ContextLine
            icon={<Boxes className="opacity-70" />}
            label={`Skills (${sent.skills.length})`}
            preview={sent.skills.map((s) => s.name).join(" · ")}
            onOpen={() => setOpenKey("skills")}
          />
        )}
      </div>
      <ContextViewerModal
        open={open}
        onClose={() => setOpenKey(null)}
        title="Sent context — session start"
        description="Everything Dispatch handed the agent when this session was built. Claude Code's own base prompt and CLAUDE.md files come on top — see Token breakdown."
        items={items}
        initialKey={openKey ?? undefined}
        loading={loadingFull}
      />
    </div>
  );
}
