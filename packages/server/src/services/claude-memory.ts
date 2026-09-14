/**
 * claude-memory — a window onto Claude Code's OWN auto-memory for a project,
 * `~/.claude/projects/<slug>/memory/`.
 *
 * Claude Code loads that dir's `MEMORY.md` into every session it runs for the
 * repo, independently of Dispatch's project memory — so a chat carries two
 * memory systems and only one of them was visible in the app. This reads,
 * edits and deletes those files in place. It never writes new ones: Claude Code
 * owns the format, and a Dispatch-invented file would be one it didn't expect.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ClaudeMemoryFile, ClaudeMemoryListing } from "@dispatch/shared";
import { parseFrontmatter } from "./project-config.js";

export const CLAUDE_MEMORY_INDEX = "MEMORY.md";

/**
 * A plain `<name>.md` — no separators, no leading dot. The file name arrives
 * from a URL, so this is the traversal guard as much as a format check.
 */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export class ClaudeMemoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

/**
 * Claude Code's project-dir slug: every non-alphanumeric char becomes `-`, so
 * `C:\Users\me\repo` → `C--Users-me-repo`.
 */
export function claudeProjectSlug(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ClaudeMemoryOptions {
  /** Claude Code's config root. Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeRoot?: string;
}

export class ClaudeMemoryService {
  private readonly root: string;

  constructor(opts: ClaudeMemoryOptions = {}) {
    this.root = opts.claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  dir(repoPath: string): string {
    return join(this.root, "projects", claudeProjectSlug(repoPath), "memory");
  }

  private assertFile(file: string): void {
    if (!FILE_RE.test(file)) throw new ClaudeMemoryError(`not a memory file name: ${file}`);
  }

  private async readOne(dir: string, file: string): Promise<ClaudeMemoryFile | null> {
    const path = join(dir, file);
    try {
      const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      let data: Record<string, unknown> = {};
      let body = content.replace(/\r\n/g, "\n").trim();
      try {
        ({ data, body } = parseFrontmatter(content));
      } catch {
        /* malformed frontmatter — show the raw file rather than hide it */
      }
      const meta =
        data.metadata && typeof data.metadata === "object"
          ? (data.metadata as Record<string, unknown>)
          : {};
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      return {
        file,
        name: str(data.name) ?? file.replace(/\.md$/i, ""),
        description: str(data.description) ?? "",
        type: str(data.type) ?? str(meta.type),
        body,
        content,
        isIndex: file === CLAUDE_MEMORY_INDEX,
        updatedAt: info.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async list(repoPath: string): Promise<ClaudeMemoryListing> {
    const dir = this.dir(repoPath);
    if (!existsSync(dir)) return { dir, exists: false, files: [] };
    let names: string[] = [];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && FILE_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      /* unreadable → empty listing */
    }
    const files = (await Promise.all(names.map((n) => this.readOne(dir, n)))).filter(
      (f): f is ClaudeMemoryFile => !!f,
    );
    files.sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.name.localeCompare(b.name));
    return { dir, exists: true, files };
  }

  /** Overwrite an EXISTING file's full content. */
  async write(repoPath: string, file: string, content: string): Promise<ClaudeMemoryFile> {
    this.assertFile(file);
    const dir = this.dir(repoPath);
    const path = join(dir, file);
    if (!existsSync(path)) throw new ClaudeMemoryError(`no such memory file: ${file}`, 404);
    await writeFile(path, content.replace(/\r\n/g, "\n"), "utf8");
    const saved = await this.readOne(dir, file);
    if (!saved) throw new ClaudeMemoryError(`could not read back ${file}`);
    return saved;
  }

  /**
   * Delete a memory file AND its pointer line in `MEMORY.md`. Leaving the line
   * would hand every future Claude Code session a link to a file that's gone.
   * The index itself can't be deleted — edit it instead.
   */
  async delete(repoPath: string, file: string): Promise<void> {
    this.assertFile(file);
    if (file === CLAUDE_MEMORY_INDEX) {
      throw new ClaudeMemoryError("MEMORY.md is the index — edit it rather than delete it");
    }
    const dir = this.dir(repoPath);
    const path = join(dir, file);
    if (!existsSync(path)) throw new ClaudeMemoryError(`no such memory file: ${file}`, 404);
    await rm(path, { force: true });

    const indexPath = join(dir, CLAUDE_MEMORY_INDEX);
    if (!existsSync(indexPath)) return;
    const index = await readFile(indexPath, "utf8");
    const link = `(${file})`;
    const kept = index.split(/\r?\n/).filter((line) => !line.includes(link));
    const next = kept.join("\n");
    if (next !== index.replace(/\r\n/g, "\n")) await writeFile(indexPath, next, "utf8");
  }
}
