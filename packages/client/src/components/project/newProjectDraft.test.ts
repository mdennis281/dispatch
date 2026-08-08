import { describe, it, expect } from "vitest";
import { projectToManifest, renderManifestYaml } from "@dispatch/shared";
import {
  DEFAULT_WORKTREE_ROOT,
  derivedRepoPath,
  dirNameFromProjectName,
  draftReady,
  draftSubApps,
  draftToProject,
  emptyDraft,
  emptySubApp,
  resolvedWorktreeRoot,
  withName,
} from "./newProjectDraft.js";

describe("dirNameFromProjectName", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(dirNameFromProjectName("Acme Billing API")).toBe("acme-billing-api");
  });

  it("collapses runs of punctuation into one hyphen", () => {
    expect(dirNameFromProjectName("Acme // Billing (v2)")).toBe("acme-billing-v2");
  });

  it("keeps characters a filesystem is happy with", () => {
    expect(dirNameFromProjectName("my_app.v2")).toBe("my_app.v2");
  });

  it("never leads or trails with a separator", () => {
    expect(dirNameFromProjectName("  ...Acme!  ")).toBe("acme");
  });

  it("is empty for a name with nothing usable in it", () => {
    expect(dirNameFromProjectName("!!!")).toBe("");
  });
});

describe("derivedRepoPath", () => {
  it("joins the projects root and the derived directory", () => {
    expect(derivedRepoPath("C:/Users/me/projects", "Acme Billing")).toBe(
      "C:/Users/me/projects/acme-billing",
    );
  });

  it("normalizes a backslashed root and a trailing slash", () => {
    expect(derivedRepoPath("C:\\Users\\me\\projects\\", "Acme")).toBe("C:/Users/me/projects/acme");
  });

  it("suggests nothing when the name yields no directory", () => {
    expect(derivedRepoPath("C:/p", "  ")).toBe("");
  });
});

describe("withName", () => {
  it("carries the path along while it is still following", () => {
    const d = withName(emptyDraft(), "Acme", "C:/p");
    expect(d.repoPath).toBe("C:/p/acme");
    expect(withName(d, "Acme Two", "C:/p").repoPath).toBe("C:/p/acme-two");
  });

  it("leaves an edited path alone", () => {
    const edited = { ...withName(emptyDraft(), "Acme", "C:/p"), repoPath: "D:/elsewhere/thing" };
    edited.touched = { repoPath: true };
    expect(withName(edited, "Renamed", "C:/p").repoPath).toBe("D:/elsewhere/thing");
  });
});

describe("resolvedWorktreeRoot", () => {
  it("resolves the default relative root against the repo", () => {
    expect(resolvedWorktreeRoot("C:/p/app", DEFAULT_WORKTREE_ROOT)).toBe("C:/p/app/.worktrees");
  });

  it("collapses a sibling layout instead of showing the dots back", () => {
    expect(resolvedWorktreeRoot("C:/p/app", "../app-worktrees")).toBe("C:/p/app-worktrees");
  });

  it("leaves an absolute root alone", () => {
    expect(resolvedWorktreeRoot("C:/p/app", "D:/wt")).toBe("D:/wt");
    expect(resolvedWorktreeRoot("/home/me/app", "/var/wt")).toBe("/var/wt");
  });

  it("keeps a posix repo path rooted", () => {
    expect(resolvedWorktreeRoot("/home/me/app", ".worktrees")).toBe("/home/me/app/.worktrees");
  });
});

describe("draftSubApps", () => {
  it("drops rows that don't carry both a name and a path", () => {
    const rows = [
      { ...emptySubApp(), name: "web", path: "apps/web" },
      { ...emptySubApp(), name: "api" },
      emptySubApp(),
    ];
    expect(draftSubApps(rows).map((a) => a.id)).toEqual(["web"]);
  });

  it("parses ports out of free text and omits empty optionals", () => {
    const [app] = draftSubApps([
      { ...emptySubApp(), name: "Web App", path: "apps/web", dev: "pnpm dev", ports: "5173, 5174" },
    ]);
    expect(app).toEqual({
      id: "web-app",
      name: "Web App",
      path: "apps/web",
      dev: "pnpm dev",
      ports: [5173, 5174],
    });
  });
});

describe("draftToProject", () => {
  it("trims and omits an empty default branch", () => {
    const d = { ...emptyDraft(), name: " Acme ", repoPath: " C:/p/acme ", defaultBranch: "  " };
    const body = draftToProject(d);
    expect(body.name).toBe("Acme");
    expect(body.repoPath).toBe("C:/p/acme");
    expect(body).not.toHaveProperty("defaultBranch");
  });

  it("renders through the same manifest functions the server writes with", () => {
    const d = withName(emptyDraft(), "Acme Billing", "C:/p");
    d.workflow = { profile: "review" };
    d.subApps = [{ ...emptySubApp(), name: "web", path: "apps/web", dev: "pnpm dev", ports: "5173" }];
    const yaml = renderManifestYaml(projectToManifest(draftToProject(d)));
    expect(yaml).toContain("name: Acme Billing");
    expect(yaml).toContain("worktreeRoot: .worktrees");
    expect(yaml).toContain("profile: review");
    expect(yaml).toContain("cwd: apps/web");
    // Identity/runtime fields belong to `.data`, never to the committed file.
    expect(yaml).not.toContain("repoPath");
    expect(yaml).not.toContain("defaultBranch");
  });
});

describe("draftReady", () => {
  it("needs the two things nobody else can guess", () => {
    expect(draftReady(emptyDraft())).toBe(false);
    expect(draftReady({ ...emptyDraft(), name: "Acme" })).toBe(false);
    expect(draftReady({ ...emptyDraft(), name: "Acme", repoPath: "C:/p/acme" })).toBe(true);
  });

  it("refuses a cleared worktree root, which would resolve to the repo itself", () => {
    // Empty is worse than unanswered: `resolve(repo, "")` is the repo, so the
    // first task worktree would land inside the main checkout.
    const cleared = { ...emptyDraft(), name: "Acme", repoPath: "C:/p/acme", worktreeRoot: "  " };
    expect(draftReady(cleared)).toBe(false);
    expect(resolvedWorktreeRoot(cleared.repoPath, cleared.worktreeRoot)).toBe(cleared.repoPath);
  });
});
