/**
 * Resolving a config section's contents to the FILES that define them.
 *
 * Pure and separate from the pane that renders it, because this is the logic
 * that decides what a Delete button removes. Every kind of config here has its
 * own relationship to disk — an agent's id is a slug of its frontmatter name and
 * need not match its filename; a skill is either a directory or a flat file; an
 * instruction's manifest path may be relative to either of two roots; MCP
 * servers and sub-apps have no file of their own at all. Guessing any of those
 * means deleting the wrong thing, so each is resolved explicitly from what the
 * loader reported rather than reconstructed from a naming convention.
 */
import type { ConfigSection, ProjectConfig, ProjectMemory } from "@dispatch/shared";

/** One listed config item, resolved to the file that defines it. */
export interface SectionItem {
  key: string;
  title: string;
  sub?: string;
  /**
   * Config-dir-relative source file. Absent = nothing to open (an inline
   * manifest instruction, a memory).
   */
  rel?: string;
  /**
   * False for manifest-backed items: an MCP server or sub-app lives inside
   * `project.yaml` alongside everything else, so "delete" would mean rewriting
   * that file, not removing it. Those get Edit only.
   */
  deletable?: boolean;
}

/** Last path segment of an absolute dir, tolerant of either separator. */
export function dirName(abs: string | undefined, fallback: string): string {
  if (!abs) return fallback;
  const parts = abs.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || fallback;
}

/** The items to list for a section, each resolved to its source file. */
export function sectionItems(
  section: ConfigSection,
  config: ProjectConfig | null,
  memories: ProjectMemory[],
): SectionItem[] {
  if (!config) return [];
  switch (section) {
    case "instructions":
      return config.instructions.map((ins, i) => ({
        key: `${i}`,
        title: ins.source === "file" ? (ins.file ?? "file") : "inline text",
        sub: ins.text.slice(0, 90).replace(/\n/g, " "),
        // `rel` is where it RESOLVED; `file` is what the manifest said.
        rel: ins.rel,
        deletable: ins.source === "file" && !!ins.rel,
      }));
    case "agents":
      return config.agents.map((a) => ({
        key: a.id,
        title: a.name,
        sub: [a.permissionMode, a.model].filter(Boolean).join(" · "),
        rel: a.file ? `${dirName(config.agentsDir, "agents")}/${a.file}` : undefined,
        deletable: !!a.file,
      }));
    case "modes":
      return config.modes.map((m) => ({
        key: m.id,
        title: m.name,
        sub: [m.permissionMode, m.description].filter(Boolean).join(" · "),
        rel: m.file ? `${dirName(config.modesDir, "modes")}/${m.file}` : undefined,
        deletable: !!m.file,
      }));
    case "skills":
      return config.skills.map((s) => {
        const base = dirName(config.skillsDir, "skills");
        return {
          key: s.id,
          title: s.name,
          sub: s.description,
          rel:
            s.layout === "dir"
              ? `${base}/${s.dir}/SKILL.md`
              : `${base}/${dirName(s.path, `${s.dir}.md`)}`,
          deletable: true,
        };
      });
    case "mcp":
      return Object.entries(config.mcpServers).map(([name, cfg]) => ({
        key: name,
        title: name,
        sub: cfg.type ?? "stdio",
        rel: "project.yaml",
        deletable: false,
      }));
    case "subApps":
      return config.subApps.map((s) => ({
        key: s.id,
        title: s.name || s.id,
        sub: [s.path, s.ports?.length ? `:${s.ports.join(", :")}` : ""]
          .filter(Boolean)
          .join(" · "),
        rel: "project.yaml",
        deletable: false,
      }));
    case "memory":
      return memories.map((m) => ({ key: m.name, title: m.name, sub: m.description }));
    default:
      return [];
  }
}

/**
 * What a Delete actually removes, or undefined when the item isn't deletable.
 *
 * A skill directory's target is the DIRECTORY, not its SKILL.md: removing just
 * the manifest file would leave an orphaned folder of scripts and references on
 * disk — the skill gone from the app but still in the repo, which is worse than
 * either outcome.
 */
export function deleteTarget(
  section: ConfigSection,
  item: SectionItem,
): string | undefined {
  if (!item.rel || item.deletable === false) return undefined;
  if (section === "skills" && item.rel.endsWith("/SKILL.md")) {
    return item.rel.slice(0, -"/SKILL.md".length);
  }
  return item.rel;
}
