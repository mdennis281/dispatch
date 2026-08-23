/**
 * The new-project draft — everything the setup page holds, and the derivations
 * that keep its fields honest as you type.
 *
 * Split out of the view because these are the rules worth testing: a directory
 * name derived from a display name, a worktree root resolved against a repo
 * path, a draft mapped onto the Project the server stores. The view is then just
 * the arrangement of controls around them.
 *
 * **Derived-until-touched.** Typing a name fills the path; editing the path
 * stops it following. That's the only sane behaviour for a pair of fields where
 * one is usually a function of the other and occasionally isn't — auto-fill that
 * keeps overwriting your edit is worse than no auto-fill, and a path you have to
 * type in full every time is worse than both. Each derived field carries its own
 * `touched` flag rather than one global one, so correcting the path doesn't also
 * freeze the branch.
 */
import type { Project, SubApp, WorkflowConfig } from "@dispatch/shared";

/**
 * Where per-task worktrees go, by default.
 *
 * `git worktree` places a worktree wherever you point it, so "the standard" is a
 * convention rather than a rule — and the convention worktree tooling has
 * settled on is a single dedicated directory per repo, holding one subdirectory
 * per branch, gitignored. Keeping it INSIDE the repo (`<repo>/.worktrees/<branch>`)
 * rather than beside it is what makes a project one directory you can move,
 * back up or delete as a unit; the older `../<repo>-worktrees` sibling layout
 * scatters that across the parent folder and breaks the moment two repos share
 * a name. Dispatch resolves a relative worktree root against the repo, so this
 * value stays portable across machines — which an absolute path never is.
 *
 * THAT TRADE FLIPS ON A BUSY REPO, and the default does not follow it there.
 * An in-repo root means the checkout contains N copies of itself, and while
 * .gitignore hides them from `git status` it hides them from nothing that walks
 * the filesystem. Measured on this repo at ~100 live worktrees: a plain
 * `grep -rn` from the repo root ran past a two-minute timeout without
 * answering, because each search re-read 100 trees. A handful of worktrees
 * costs nothing and the move-as-a-unit win is real; a repo running many agents
 * at once wants a parent-relative root instead. Dispatch's own manifest is the
 * worked example — `.dispatch/project.yaml` sets `../.worktrees/dispatch`,
 * which keeps one directory per project (no sibling scatter, no name
 * collisions) while leaving the checkout searchable.
 */
export const DEFAULT_WORKTREE_ROOT = ".worktrees";

/** The trunk a fresh repo is initialized on, and the default diff/PR base. */
export const DEFAULT_BRANCH = "main";

/** One sub-app row in the form (all strings — parsed on the way out). */
export interface SubAppDraft {
  key: string;
  name: string;
  path: string;
  dev: string;
  ports: string;
  url: string;
}

export interface NewProjectDraft {
  name: string;
  repoPath: string;
  worktreeRoot: string;
  defaultBranch: string;
  workflow: WorkflowConfig;
  subApps: SubAppDraft[];
  /** Fields the human has edited by hand; these stop following their source. */
  touched: { repoPath?: boolean; worktreeRoot?: boolean; defaultBranch?: boolean };
}

let keySeq = 0;
export const emptySubApp = (): SubAppDraft => ({
  key: `sa_${keySeq++}`,
  name: "",
  path: "",
  dev: "",
  ports: "",
  url: "",
});

export function emptyDraft(): NewProjectDraft {
  return {
    name: "",
    repoPath: "",
    worktreeRoot: DEFAULT_WORKTREE_ROOT,
    defaultBranch: DEFAULT_BRANCH,
    // `none` is the honest starting rung: a project being created right now has
    // no CI, often no remote, and nothing to review. Graduating to `commit` or
    // `review` is a decision made once the repo has earned it.
    workflow: { profile: "none" },
    subApps: [emptySubApp()],
    touched: {},
  };
}

/* ---------------------------------------------------------------- deriving */

/**
 * A display name as a directory name: lowercased, spaces and punctuation
 * collapsed to single hyphens, and nothing left that a filesystem would argue
 * with. "Acme Billing API" → `acme-billing-api`.
 */
export function dirNameFromProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** "id-ish" slug for a sub-app id (mirrors the old add-project dialog). */
export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<root>/<dir>` with forward slashes — the path the form suggests. */
export function derivedRepoPath(projectsRoot: string, name: string): string {
  const dir = dirNameFromProjectName(name);
  if (!dir) return "";
  const root = projectsRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return root ? `${root}/${dir}` : dir;
}

/**
 * Where the worktree root actually lands — a relative root resolved against the
 * repo, an absolute one left alone. Purely for display: the server does the same
 * resolution for real (`resolve(repoPath, worktreeRoot)`), and a form that shows
 * `.worktrees` without saying where that IS just moves the question.
 */
export function resolvedWorktreeRoot(repoPath: string, worktreeRoot: string): string {
  const wt = worktreeRoot.trim().replace(/\\/g, "/");
  const repo = repoPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!wt) return repo;
  // Absolute: a POSIX root, or a Windows drive.
  if (wt.startsWith("/") || /^[a-zA-Z]:/.test(wt)) return wt;
  if (!repo) return wt;
  // `..` segments are common enough in a sibling layout to be worth collapsing
  // rather than showing back as `C:/projects/app/../app-worktrees`.
  const parts = `${repo}/${wt}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(p);
  }
  return `${parts[0] === "" ? "/" : ""}${out.join("/")}`;
}

/**
 * Apply a name edit, carrying the derived fields that are still following it.
 * Returns a whole draft (rather than mutating) so React state stays a value.
 */
export function withName(
  draft: NewProjectDraft,
  name: string,
  projectsRoot: string,
): NewProjectDraft {
  return {
    ...draft,
    name,
    repoPath: draft.touched.repoPath ? draft.repoPath : derivedRepoPath(projectsRoot, name),
  };
}

/* ----------------------------------------------------------------- mapping */

function parsePorts(s: string): number[] | undefined {
  const nums = s
    .split(/[\s,]+/)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? nums : undefined;
}

/** The sub-app rows that carry enough to be real (name + path), as SubApps. */
export function draftSubApps(rows: SubAppDraft[]): SubApp[] {
  return rows
    .filter((r) => r.name.trim() && r.path.trim())
    .map((r) => {
      const app: SubApp = {
        id: slug(r.name) || slug(r.path) || `app-${r.key}`,
        name: r.name.trim(),
        path: r.path.trim(),
      };
      if (r.dev.trim()) app.dev = r.dev.trim();
      const ports = parsePorts(r.ports);
      if (ports) app.ports = ports;
      if (r.url.trim()) app.url = r.url.trim();
      return app;
    });
}

/**
 * The draft as the project record the server will store — and, through
 * `projectToManifest`, as the `project.yaml` the preview pane renders. One
 * mapping for both, so what you read on the right is what gets saved.
 */
export function draftToProject(draft: NewProjectDraft): Partial<Project> & { name: string } {
  const body: Partial<Project> & { name: string } = {
    name: draft.name.trim(),
    repoPath: draft.repoPath.trim(),
    worktreeRoot: draft.worktreeRoot.trim(),
    subApps: draftSubApps(draft.subApps),
    workflow: draft.workflow,
  };
  const branch = draft.defaultBranch.trim();
  if (branch) body.defaultBranch = branch;
  return body;
}

/**
 * Name + path are the two things nobody else can guess. Everything else waits —
 * except the worktree root, which is required because an EMPTY one is worse than
 * an unanswered one: it resolves to the repo itself, so the first task worktree
 * is created inside the main checkout and every later diff reports that copy as
 * untracked. It ships with a default, so this only fires if you clear it.
 */
export function draftReady(draft: NewProjectDraft): boolean {
  return !!draft.name.trim() && !!draft.repoPath.trim() && !!draft.worktreeRoot.trim();
}
