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

/** Who put an MCP server on the session. */
export type SentContextMcpOrigin = "dispatch" | "bundled" | "project";

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
  /** Connection status the runtime reported at init ("connected", "failed"…). */
  status?: string;
}

/** One skill materialized into the session cwd for the runtime to discover. */
export interface SentContextSkill {
  name: string;
  description?: string;
}

export interface SentContext {
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
    clipped: raw.clipped === true || undefined,
  };
}

/**
 * Attach the runtime's init report to the servers Dispatch configured: the
 * tool names it lists under `mcp__<server>__…` and each server's status.
 * Servers the runtime reported that Dispatch did not configure (a user-level
 * `~/.claude.json` server, a plugin's) are appended as `project` — they are
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
      const extra: SentContextMcpServer = { name, origin: "project", transport: "unknown" };
      out.push(extra);
      byName.set(name, extra);
    }
  }
  if (toolNames.length) {
    for (const s of out) {
      const prefix = `mcp__${s.name}__`;
      s.tools = toolNames.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    }
  }
  for (const s of out) {
    const st = statusByName.get(s.name);
    if (st) s.status = st;
  }
  return out;
}
