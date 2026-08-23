/**
 * CARRY THE PERMISSION ALLOWLISTS THROUGH THE RENAME.
 *
 * When Dispatch's tools moved off the single `manager` MCP server onto eight
 * `dispatch-*` category servers, every recorded tool NAME moved with them. An
 * allow/deny entry that names the old one does not error — it silently stops
 * matching. The symptom is a permission prompt on a tool that was approved
 * months ago, which nobody files as a bug; they click through it, and the
 * regression lives forever.
 *
 * So the rename has to bring the lists. Two surfaces, two different answers,
 * because they are owned by different people:
 *
 *   - DATA DISPATCH OWNS — custom agents in the config store. Rewritten in
 *     place, idempotently, with a log line naming every change. Safe because
 *     nothing else reads or versions those files.
 *
 *   - FILES THE USER OWNS — a repo's `.claude/settings.json`, `.dispatch/`
 *     config committed to git. WARNED ABOUT, never rewritten. Silently dirtying
 *     a working tree is its own bug (an agent mid-PR would sweep the change into
 *     an unrelated commit), and `.claude/settings.json` is read by Claude Code,
 *     not by us — rewriting another tool's config file on its behalf is not
 *     ours to do. The warning names the file and the exact entries, so the fix
 *     is a copy-paste rather than a search.
 *
 * Config-sourced tool lists (`.dispatch/agents/*.md`, `.dispatch/modes/*.yaml`)
 * take a THIRD route: they are mapped as they are READ (see project-config.ts),
 * which is idempotent by construction, survives someone checking out an older
 * branch, and never writes to the tree.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findLegacyManagerMentions,
  mentionsLegacyManagerServer,
  migrateToolList,
  type AgentConfig,
} from "@dispatch/shared";

/** The slice of the store this migration needs. */
export interface ManagerToolMigrationStore {
  listAgents(): Promise<AgentConfig[]>;
  saveAgent(agent: AgentConfig): Promise<AgentConfig>;
}

/** What one run changed and what it could only complain about. */
export interface ManagerToolMigrationResult {
  /** `agent-id: old → new` for each rewritten entry. */
  rewritten: string[];
  /**
   * `agent-id: entry` for each legacy entry naming a tool that no longer exists.
   * Reported rather than guessed at — but reported LOUDLY, because a permission
   * that stopped matching is the whole reason this pass runs, and one that can
   * never match again is the worst case of it.
   */
  stranded: string[];
  /** `file: entries` for each stale mention in a file we do not own. */
  warnings: string[];
}

/** Files a human may have put a tool allowlist in that Dispatch does not own. */
const FOREIGN_SETTINGS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
];

/**
 * Rewrite stale tool names in Dispatch's own stored agents.
 *
 * Idempotent: {@link migrateToolList} only touches entries carrying the retired
 * prefix, and a rewritten entry no longer carries it — so a second run reports
 * nothing and writes nothing. That matters because this runs on EVERY boot
 * rather than behind a version marker: a marker would skip an agent restored
 * from an old backup after the migration had already "run".
 */
export async function migrateStoredAgentTools(
  store: ManagerToolMigrationStore,
): Promise<{ rewritten: string[]; stranded: string[] }> {
  const rewritten: string[] = [];
  const stranded: string[] = [];
  const agents = await store.listAgents();
  for (const agent of agents) {
    const allow = agent.allowedTools ? migrateToolList(agent.allowedTools) : undefined;
    const deny = agent.disallowedTools ? migrateToolList(agent.disallowedTools) : undefined;
    for (const entry of [...(allow?.unknown ?? []), ...(deny?.unknown ?? [])]) {
      stranded.push(`${agent.id}: ${entry}`);
    }
    if (!allow?.changed.length && !deny?.changed.length) continue;
    for (const { from, to } of [...(allow?.changed ?? []), ...(deny?.changed ?? [])]) {
      rewritten.push(`${agent.id}: ${from} → ${to}`);
    }
    await store.saveAgent({
      ...agent,
      ...(allow ? { allowedTools: allow.tools } : {}),
      ...(deny ? { disallowedTools: deny.tools } : {}),
    });
  }
  return { rewritten, stranded };
}

/**
 * Find stale mentions in files Dispatch does not own, so the human is told
 * rather than silently re-prompted. Never writes.
 *
 * An unreadable or absent file is not a finding — most repos have none of these.
 */
export async function findForeignStaleToolNames(repoPaths: readonly string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const repoPath of repoPaths) {
    for (const rel of FOREIGN_SETTINGS) {
      const file = join(repoPath, rel);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (!mentionsLegacyManagerServer(text)) continue;
      // Report the actual entries, not just the file: "this file mentions a dead
      // name" sends someone reading 200 lines of JSON.
      warnings.push(`${file}: ${findLegacyManagerMentions(text).join(", ")}`);
    }
  }
  return warnings;
}

/**
 * The whole boot-time pass. Never throws: a migration failure must not stop the
 * server from starting — the worst case if it is skipped is the permission
 * prompt it exists to prevent, which is strictly better than no Dispatch.
 */
export async function migrateManagerToolNames(
  store: ManagerToolMigrationStore,
  repoPaths: readonly string[],
  log: (message: string) => void = (m) => console.warn(m), // eslint-disable-line no-console
): Promise<ManagerToolMigrationResult> {
  const result: ManagerToolMigrationResult = { rewritten: [], stranded: [], warnings: [] };
  try {
    const agents = await migrateStoredAgentTools(store);
    result.rewritten = agents.rewritten;
    result.stranded = agents.stranded;
  } catch (err) {
    log(`[dispatch] agent tool-name migration skipped: ${String(err)}`);
  }
  try {
    result.warnings = await findForeignStaleToolNames(repoPaths);
  } catch {
    /* a scan that cannot read is a scan with no findings */
  }
  if (result.rewritten.length) {
    log(
      `[dispatch] migrated ${result.rewritten.length} tool permission entr` +
        `${result.rewritten.length === 1 ? "y" : "ies"} off the retired manager server:`,
    );
    for (const line of result.rewritten) log(`[dispatch]   ${line}`);
  }
  if (result.stranded.length) {
    log(
      "[dispatch] these permission entries name tools that no longer exist, so " +
        "they were left alone and grant nothing — remove them or replace them:",
    );
    for (const line of result.stranded) log(`[dispatch]   ${line}`);
  }
  if (result.warnings.length) {
    log(
      "[dispatch] these files still name tools on the retired manager server — " +
        "Dispatch does not own them, so they need editing by hand or the tools " +
        "they allow will start prompting:",
    );
    for (const line of result.warnings) log(`[dispatch]   ${line}`);
  }
  return result;
}
