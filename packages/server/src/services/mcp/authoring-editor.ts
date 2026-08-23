/**
 * authoring-editor — bind the three authored-guidance scopes to one session.
 *
 * The `config_*` tools take a bare `name` and an optional `scope`; this is where
 * that becomes a file. Two rules live here and nowhere else:
 *
 *  - **Reads resolve MOST-SPECIFIC-FIRST** (project → global → shipped), which
 *    is the inverse of the injection order and deliberately so. Injection goes
 *    broadest-first because the last text wins in a prompt; a LOOKUP wants the
 *    copy actually in effect, and when a project skill shadows a shipped one of
 *    the same name, the project's is the one running.
 *  - **Writes must name a writable scope.** `shipped` is delivered by an app
 *    upgrade, so a write there evaporates at the next publish.
 *
 * `repoPath` is the project's MAIN working copy, never a session worktree —
 * `.dispatch/` is committed config, and an edit made in a throwaway tree would be
 * discarded with it. Same rule, same reason, as `mcp-config-editor`.
 */
import { readFile } from "node:fs/promises";
import type {
  AuthoredItem,
  AuthoredKind,
  AuthoredScope,
  ProjectConfig,
  WritableAuthoredScope,
} from "@dispatch/shared";
import type { AuthoredConfigService } from "../authored-config.js";
import {
  deleteProjectItem,
  listProjectItems,
  readProjectItem,
  writeProjectItem,
} from "../authored-project.js";
import type { ManagerMcpAuthoring } from "./manager-mcp.js";

export interface AuthoringEditorDeps {
  authored: AuthoredConfigService;
  /** The project's main checkout, or null for a session with no project. */
  repoPath: string | null;
  /** The project's currently-loaded config, for listing. Null when unloaded. */
  getConfig: () => ProjectConfig | null;
}

/** Build the per-session authoring binding the `config_*` tools consume. */
export function createAuthoringEditor(deps: AuthoringEditorDeps): ManagerMcpAuthoring {
  const { authored, repoPath, getConfig } = deps;

  return {
    hasProject: Boolean(repoPath),

    async list(kind: AuthoredKind): Promise<AuthoredItem[]> {
      const config = getConfig();
      const project = config ? await listProjectItems(kind, config) : [];
      // Project first: the listing reads as a precedence order, and the thing a
      // session is most likely to be editing is at the top.
      return [...project, ...(await authored.list(kind))];
    },

    async read(kind, name, scope) {
      const order: AuthoredScope[] = scope ? [scope] : ["project", "global", "shipped"];
      for (const s of order) {
        if (s === "project") {
          if (!repoPath) continue;
          const found = await readProjectItem(repoPath, kind, name).catch(() => null);
          if (found) return { scope: s, path: found.path, text: found.text };
          continue;
        }
        // `global` and `shipped` are both enumerable from the app-level service,
        // so match its listing rather than re-deriving either directory here.
        const match = (await authored.list(kind)).find((i) => i.scope === s && i.name === name);
        if (!match) continue;
        const text = await readFile(match.path, "utf8").catch(() => null);
        if (text !== null) return { scope: s, path: match.path, text };
      }
      return null;
    },

    async write({ kind, scope, name, description, body }) {
      if (scope === "project") {
        if (!repoPath) throw new Error("this session has no project to write config into");
        const result = await writeProjectItem(repoPath, kind, name, body, description);
        return { path: result.path, registered: result.registered };
      }
      const path = await authored.write(kind, name, body, description);
      // A global instruction needs no registration step — the whole directory is
      // injected, which is exactly why it has no manifest to fall out of sync with.
      return { path, registered: false };
    },

    async remove(kind, name, scope: WritableAuthoredScope) {
      if (scope === "project") {
        if (!repoPath) throw new Error("this session has no project to delete config from");
        return deleteProjectItem(repoPath, kind, name);
      }
      return authored.remove(kind, name);
    },
  };
}
