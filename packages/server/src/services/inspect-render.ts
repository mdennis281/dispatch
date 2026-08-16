/**
 * Rendering for the inspection tools — structured results → the compact text an
 * agent actually reads.
 *
 * Kept apart from {@link InspectService} because the two have opposite pressures:
 * the service must stay faithful to what's on disk, while this file exists purely
 * to spend as few tokens as possible saying it. Returning raw JSON rows from the
 * tools was the obvious first cut and the wrong one — a transcript row is mostly
 * keys the reader doesn't need, and forty of them buried the answer in syntax.
 *
 * The line format is deliberately grep-shaped (`[ROW_ID kind label]`), because
 * the ids it prints are exactly what `chat_read`'s `beforeId`/`afterId` cursors
 * take — the output of one call is the input to the next.
 */
import type {
  ChatSummary,
  FindChatsResult,
  ProjectInfoResult,
  RawRow,
  ReadChatResult,
} from "./inspect.js";
import { rowLabel, rowText } from "./inspect.js";

/** Bytes → a short human size. */
function size(bytes: number | undefined): string {
  if (!bytes) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/** Epoch ms → `2026-08-16 09:31`, or `?` when absent. */
function when(ts: number | undefined): string {
  if (!ts) return "?";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Collapse whitespace so one row stays on one line. */
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function chatHeadline(c: ChatSummary): string {
  const bits = [
    c.projectName ?? c.projectId,
    c.status,
    c.archived ? "archived" : undefined,
    c.prs?.length ? `PR #${c.prs.join(", #")}` : undefined,
  ].filter(Boolean);
  return `${c.id}  ${when(c.updatedAt)}  ${c.title}\n    ${bits.join(" · ")}`;
}

/* ------------------------------------------------------------- chat_find */

export function renderFind(result: FindChatsResult, query?: string): string {
  const lines: string[] = [];
  if (!result.chats.length) {
    lines.push(
      query
        ? `No chats matched "${query}" (searched ${result.scanned} transcript(s), ${size(result.bytesScanned)}).`
        : "No chats matched those filters.",
    );
  } else {
    lines.push(
      `${result.chats.length} chat(s)${query ? ` matching "${query}"` : ""}, newest first:`,
      "",
    );
    for (const c of result.chats) {
      lines.push(chatHeadline(c));
      for (const h of c.hits ?? []) {
        const label = h.label ? ` ${h.label}` : "";
        const id = h.id ? ` ${h.id}` : "";
        lines.push(`      · [${h.kind}${label}${id}] ${oneLine(h.snippet)}`);
      }
      lines.push("");
    }
  }
  const stats = [
    `${result.candidates} chat(s) in scope`,
    result.scanned ? `${result.scanned} transcript(s) scanned (${size(result.bytesScanned)})` : null,
  ]
    .filter(Boolean)
    .join(", ");
  lines.push(`_${stats}._`);
  if (result.truncated) {
    // Never let a budget stop read as "not found".
    lines.push(
      `⚠ Scan budget reached — ${result.unscanned} older chat(s) were NOT searched. ` +
        `Narrow with \`project\`/\`since\`, or raise the budget, before concluding it isn't there.`,
    );
  }
  lines.push(
    "Read one with `chat_read` (chatId, view: 'digest' to catch up, 'grep' to search inside).",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------- chat_read */

/** One transcript row as a single grep-shaped line. */
export function renderRow(row: RawRow): string {
  const label = rowLabel(row);
  const head = [row.kind ?? "?", label].filter(Boolean).join(" ");
  const flags = [
    row.isError ? "ERROR" : undefined,
    row.ok === false ? "failed" : undefined,
    row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : undefined,
    row.images?.length ? `${row.images.length} image(s)` : undefined,
  ].filter(Boolean);
  const meta = flags.length ? ` (${flags.join(", ")})` : "";
  const id = row.id ? ` ${row.id}` : "";
  return `[${head}${id} ${when(row.ts)}]${meta} ${oneLine(rowText(row), 600)}`;
}

export function renderRead(result: ReadChatResult): string {
  const c = result.chat;
  const lines: string[] = [];

  const kinds = Object.entries(result.kindCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(" ");

  lines.push(
    `# ${c.title}`,
    `${c.id} · ${c.projectName ?? c.projectId} · ${c.status ?? "idle"}${c.archived ? " · archived" : ""}`,
    `${c.harness ?? "claude"}${c.model ? ` · ${c.model}` : ""} · created ${when(c.createdAt)} · last active ${when(c.updatedAt)}`,
    `${result.totalRows} rows (${size(c.transcriptBytes)}) — ${kinds}`,
  );
  if (c.worktrees?.length) lines.push(`worktrees: ${c.worktrees.join(", ")}`);
  if (c.prs?.length) lines.push(`PRs: ${c.prs.map((n) => `#${n}`).join(", ")}`);
  lines.push("");

  if (result.view === "digest") {
    // The human's own words are the cheapest, highest-signal summary of intent
    // there is — they're what the whole chat was steered by.
    const asks = result.userMessages ?? [];
    lines.push(`## What was asked (${asks.length} user message(s))`);
    for (const row of asks) lines.push(`- [${when(row.ts)}] ${oneLine(row.text ?? "", 500)}`);
    lines.push("");

    if (result.problems?.length) {
      lines.push(`## Problems (last ${result.problems.length})`);
      for (const row of result.problems) lines.push(`- ${renderRow(row)}`);
      lines.push("");
    }

    lines.push(`## Latest activity (${result.rows.length} rows)`);
    for (const row of result.rows) lines.push(renderRow(row));
  } else {
    lines.push(`## Rows (${result.rows.length})`);
    for (const row of result.rows) lines.push(renderRow(row));
  }

  if (result.images.length) {
    lines.push("", `## Images (${result.images.length}) — read these paths directly`);
    for (const img of result.images.slice(0, 40)) {
      lines.push(`- ${when(img.ts)} ${img.path}${img.alt ? ` — ${img.alt}` : ""}`);
    }
    if (result.images.length > 40) {
      lines.push(`- …${result.images.length - 40} more`);
    }
  }

  if (result.truncated) {
    lines.push(
      "",
      `_Showing ${result.rows.length} of ${result.totalRows} rows. Page with \`beforeId\` ` +
        "(the oldest id above) or narrow with `kinds` / `view: 'grep'`._",
    );
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------- project_info */

export function renderProject(result: ProjectInfoResult): string {
  const p = result.project;
  const lines: string[] = [
    `# ${p.name}`,
    `${p.id} · ${p.repoPath}`,
    `workflow: ${p.workflow ?? "default"} · harness: ${p.harness ?? "claude"} · default branch: ${p.defaultBranch ?? "main"}`,
    `worktree root: ${p.worktreeRoot ?? "(unset)"}`,
    "",
  ];

  lines.push(
    result.configSourceDir
      ? `## .dispatch config — ${result.configSourceDir}`
      : "## .dispatch config — none (this project runs off the store record only)",
  );
  if (result.configErrors.length) {
    for (const e of result.configErrors) {
      lines.push(`  ⚠ ${e.file ? `${e.file}: ` : ""}${e.message}`);
    }
  }
  const listing = (label: string, items: string[]) =>
    items.length ? `  ${label}: ${items.join(", ")}` : null;
  for (const line of [
    listing("agents", result.agents),
    listing("modes", result.modes),
    listing("skills", result.skills),
    listing("mcp servers", result.mcpServers),
  ]) {
    if (line) lines.push(line);
  }

  if (result.subApps.length) {
    lines.push("", "## SubApps");
    for (const s of result.subApps) {
      const bits = [s.ports?.length ? `ports ${s.ports.join(",")}` : null, s.url].filter(Boolean);
      lines.push(`- ${s.id} (${s.name})${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
    }
  }

  if (result.instructions) {
    lines.push("", "## Instructions", result.instructions);
  }

  if (result.memoryIndex) {
    lines.push("", "## Memory index", result.memoryIndex);
  }

  if (result.recentChats.length) {
    lines.push("", `## Recent chats (${result.recentChats.length})`);
    for (const c of result.recentChats) lines.push(`- ${chatHeadline(c)}`);
  }
  return lines.join("\n");
}
