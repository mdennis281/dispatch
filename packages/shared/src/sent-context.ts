/**
 * What Dispatch handed the agent when it built a session — the disclosure
 * behind "show sent context".
 *
 * The per-turn injections (surfaced memories, a sweep's repo snapshot) were
 * always auditable: they ride as `context` parts on the user row. The bulk of
 * what Dispatch sends is not per-turn, though. The system-prompt append — the
 * workflow contract, the MCP capability map, house rules, every global and
 * project instruction file, the memory catalogue, the persona — plus the MCP
 * servers and skills attached to the session, are built ONCE per session in
 * `buildOptions`, and nothing recorded them. A chat sitting on a 55k-token
 * baseline could show "show sent context" switched on and display a two-line
 * memory note, which is a lie of omission about where the window went.
 *
 * So the broker records each section as it appends it and stamps the lot onto
 * the session's `init` row (`data.sentContext`) — the one row every session
 * start writes, on every runtime. Per-SESSION, matching where it actually
 * enters; a resume or a mode switch rebuilds the prompt and discloses again.
 */

/**
 * `system` row subtype for a turn of input Dispatch sent on its own — a guard
 * recovery's "continue the task", say. `data` is `{ label, text }`. Rendered
 * only under "show sent context", like every other disclosure.
 */
export const DISPATCH_INPUT_SUBTYPE = "dispatch-input";

/** One block of the system-prompt append, in the order it was sent. */
export interface SentContextSection {
  /** Stable kind ("workflow", "house-rules", "instructions:project"…). */
  id: string;
  /** Human heading for the transcript ("Workflow profile — review"). */
  label: string;
  /**
   * The text as sent. On the WIRE this is clipped to a preview (see
   * `transcript-lean.ts`) with `chars` keeping the true length; the full row
   * comes from `/messages/full` when the human drills in.
   */
  text: string;
  /** Length of the full text, so a clipped preview can still say how big it is. */
  chars: number;
}

/**
 * Who put an MCP server on the session. `external` is one the RUNTIME attached
 * that Dispatch never configured — a user-level `~/.claude.json` entry, a
 * plugin's. Still on the session, still paying for its schemas.
 */
export type SentContextMcpOrigin = "dispatch" | "bundled" | "project" | "external";

/** One MCP server handed to the runtime. */
export interface SentContextMcpServer {
  name: string;
  origin: SentContextMcpOrigin;
  /** `stdio` / `http` / `sse` / `in-process` — never the command or headers (secrets). */
  transport: string;
  /**
   * The tool names the runtime reported for it at init, when it reported any.
   * Absent ≠ zero: Codex and goose don't list tools at init.
   */
  tools?: string[];
  /**
   * How many tools, on a LEAN (wire) copy where `tools` was dropped — a
   * hundred-odd names is the very list the projection keeps off every page
   * load, and the card only needs the count.
   */
  toolCount?: number;
  /** Connection status the runtime reported at init ("connected", "failed"…). */
  status?: string;
}

/** One skill materialized into the session cwd for the runtime to discover. */
export interface SentContextSkill {
  name: string;
  description?: string;
}

export interface SentContext {
  /**
   * Set when the sections are identical to an earlier session start's: that
   * row's id. The sections here then keep labels and sizes but empty texts.
   * An idle sweep restarts sessions all day, and re-writing a 50KB prompt into
   * an append-only transcript each time would be pure bloat. The drill-down
   * fetches the referenced row for the texts.
   */
  sameAs?: string;
  sections: SentContextSection[];
  mcpServers: SentContextMcpServer[];
  skills: SentContextSkill[];
  /** True on a lean (wire) copy whose section texts are previews. */
  clipped?: boolean;
}

/**
 * Read `data.sentContext` off an init row, tolerating anything — `data` is
 * `unknown` on the schema and rows written before this existed carry none.
 */
export function readSentContext(data: unknown): SentContext | undefined {
  const raw = (data as { sentContext?: unknown } | undefined)?.sentContext as
    | Partial<SentContext>
    | undefined;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.sections)) return undefined;
  return {
    sections: raw.sections.filter(
      (s): s is SentContextSection =>
        !!s && typeof s.label === "string" && typeof s.text === "string",
    ),
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    sameAs: typeof raw.sameAs === "string" ? raw.sameAs : undefined,
    clipped: raw.clipped === true || undefined,
  };
}

/**
 * The summary copy of a sent context: labels and sizes, tool COUNTS, skill
 * names, and each section's text cut to `previewChars` (0 = no text at all).
 *
 * One function for every place the row leaves the full transcript. The lean
 * wire keeps a one-line preview; integration reads and webhooks keep none, because
 * the bodies are the memory catalogue, machine-wide instructions and every
 * repo path — content an integration token's scope never granted, and which
 * reached those channels only because it now sits on a row they forward.
 */
export function summarizeSentContext(sent: SentContext, previewChars: number): SentContext {
  return {
    ...sent,
    sections: sent.sections.map((s) => ({
      ...s,
      text:
        previewChars <= 0
          ? ""
          : s.text.length <= previewChars
            ? s.text
            : `${s.text.slice(0, previewChars)}…`,
      chars: s.chars ?? s.text.length,
    })),
    mcpServers: sent.mcpServers.map(({ tools, ...s }) => ({
      ...s,
      ...(tools || s.toolCount !== undefined ? { toolCount: tools?.length ?? s.toolCount } : {}),
    })),
    skills: sent.skills.map((s) => ({ name: s.name })),
    clipped: true,
  };
}

/**
 * A row's `data` with its sent context reduced to {@link summarizeSentContext}
 * at `previewChars`. Any other data passes through untouched; a row without one
 * comes back as the same object.
 */
export function withSentContextSummary(data: unknown, previewChars: number): unknown {
  const sent = readSentContext(data);
  if (!sent) return data;
  return { ...(data as Record<string, unknown>), sentContext: summarizeSentContext(sent, previewChars) };
}

/** Tool count whether the names are present (full row) or only counted (lean). */
export function mcpToolCount(server: SentContextMcpServer): number | undefined {
  return server.tools?.length ?? server.toolCount;
}

/**
 * How the Claude runtime spells a server inside a tool name: anything outside
 * `[A-Za-z0-9_-]` becomes `_`, so "claude.ai Gmail" is `mcp__claude_ai_Gmail__…`.
 * Matching the configured name literally filed none of its tools under it.
 */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
}

/**
 * Attach the runtime's init report to the servers Dispatch configured: the
 * tool names it lists under `mcp__<server>__…` and each server's status.
 * Servers the runtime reported that Dispatch did not configure (a user-level
 * `~/.claude.json` server, a plugin's) are appended as `external` — they are
 * on the session and they cost tokens, so leaving them out would undercount.
 */
export function withRuntimeMcpReport(
  servers: SentContextMcpServer[],
  tools: unknown,
  status: unknown,
): SentContextMcpServer[] {
  const toolNames = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [];
  const statusByName = new Map<string, string>();
  if (Array.isArray(status)) {
    for (const s of status as { name?: unknown; status?: unknown }[]) {
      if (typeof s?.name === "string" && typeof s.status === "string") statusByName.set(s.name, s.status);
    }
  }
  const out = servers.map((s) => ({ ...s }));
  const byName = new Map(out.map((s) => [s.name, s]));
  for (const name of statusByName.keys()) {
    if (!byName.has(name)) {
      const extra: SentContextMcpServer = { name, origin: "external", transport: "unknown" };
      out.push(extra);
      byName.set(name, extra);
    }
  }
  if (toolNames.length) {
    for (const s of out) {
      const prefix = mcpToolPrefix(s.name);
      s.tools = toolNames.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    }
  }
  for (const s of out) {
    const st = statusByName.get(s.name);
    if (st) s.status = st;
  }
  return out;
}
