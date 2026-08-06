/**
 * "Add project" dialog — a project = one repo with many subApps. Collects the
 * repo/worktree roots + a dense set of subApp rows, POSTs to the REST projects
 * endpoint, then upserts + focuses the new project. Submit is gated (disabled)
 * until the required paths are present rather than erroring after a click.
 */
import { useState } from "react";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import type { Project, SubApp } from "@dispatch/shared";
import { Modal, Field, TextInput, InlineError } from "./Modal.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { api } from "../../lib/api.js";
import { useProjects } from "../../stores/projects.js";

interface SubAppDraft {
  key: string;
  name: string;
  path: string;
  dev: string;
  ports: string;
  url: string;
}

let keySeq = 0;
const emptyRow = (): SubAppDraft => ({
  key: `sa_${keySeq++}`,
  name: "",
  path: "",
  dev: "",
  ports: "",
  url: "",
});

/** "id-ish" slug from a free-text name. */
function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePorts(s: string): number[] | undefined {
  const nums = s
    .split(/[\s,]+/)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? nums : undefined;
}

export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [subApps, setSubApps] = useState<SubAppDraft[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim() && repoPath.trim() && worktreeRoot.trim();

  const patchRow = (key: string, patch: Partial<SubAppDraft>) =>
    setSubApps((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function reset() {
    setName("");
    setRepoPath("");
    setWorktreeRoot("");
    setDefaultBranch("");
    setSubApps([emptyRow()]);
    setError(null);
    setBusy(false);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const apps: SubApp[] = subApps
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

    const body: Partial<Project> = {
      name: name.trim(),
      repoPath: repoPath.trim(),
      worktreeRoot: worktreeRoot.trim(),
      subApps: apps,
    };
    if (defaultBranch.trim()) body.defaultBranch = defaultBranch.trim();

    try {
      const saved = await api.projects.create(body);
      useProjects.getState().upsertProject(saved);
      useProjects.getState().setActiveProject(saved.id);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      width={560}
      icon={<FolderGit2 />}
      title="Add project"
      description="One git repo with many subApps."
      footer={
        <>
          {error && (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          )}
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Name" required>
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Hivebreak"
          />
        </Field>
        <Field label="Repo path" required hint="absolute path to the working copy">
          <TextInput
            mono
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="C:/Users/you/projects/app"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Worktree root" required hint="per-task worktrees">
            <TextInput
              mono
              value={worktreeRoot}
              onChange={(e) => setWorktreeRoot(e.target.value)}
              placeholder="…/app-worktrees"
            />
          </Field>
          <Field label="Default branch" hint="diff / PR base">
            <TextInput
              mono
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
            />
          </Field>
        </div>

        <div className="pt-1">
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel className="px-0">SubApps</SectionLabel>
            <IconButton
              size="sm"
              tip="Add subApp"
              onClick={() => setSubApps((rows) => [...rows, emptyRow()])}
            >
              <Plus />
            </IconButton>
          </div>

          <div className="space-y-1.5">
            {subApps.map((r) => (
              <div
                key={r.key}
                className="grid grid-cols-[1fr_1.3fr_1.2fr_0.7fr_auto] items-center gap-1.5"
              >
                <TextInput
                  value={r.name}
                  onChange={(e) => patchRow(r.key, { name: e.target.value })}
                  placeholder="game"
                />
                <TextInput
                  mono
                  value={r.path}
                  onChange={(e) => patchRow(r.key, { path: e.target.value })}
                  placeholder="apps/client"
                />
                <TextInput
                  mono
                  value={r.dev}
                  onChange={(e) => patchRow(r.key, { dev: e.target.value })}
                  placeholder="pnpm dev"
                />
                <TextInput
                  mono
                  value={r.ports}
                  onChange={(e) => patchRow(r.key, { ports: e.target.value })}
                  placeholder="5173"
                />
                <IconButton
                  size="sm"
                  tip="Remove"
                  onClick={() =>
                    setSubApps((rows) =>
                      rows.length > 1 ? rows.filter((x) => x.key !== r.key) : [emptyRow()],
                    )
                  }
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-faint">
            Name + path are required per row; empty rows are ignored.
          </p>
        </div>
      </div>
    </Modal>
  );
}
