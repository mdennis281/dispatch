/**
 * ProjectConfigView — the project's `.dispatch/` config, section by section.
 *
 * The old version was a wall of counts: "Modes: 2", "Skills: 0". It told you
 * what existed and nothing about what any of it WAS, so the only people who
 * could use it were the ones who already knew. This one is a section rail plus a
 * detail pane: pick a section, read what it's for, see what this project has,
 * and add to it either by opening the file or by describing what you want and
 * letting an agent write it (in a chat you can watch and steer).
 *
 * Editing rules that shaped the layout:
 *
 *   - The workflow block is EDITABLE and held as a local draft behind an
 *     explicit Save. A settings dialog that writes on every click gives you
 *     nothing to confirm and no way to back out — and a manifest-backed project
 *     can only be saved correctly as a whole block, since `project.yaml`
 *     overrides `.data` on every config reload. Closing dirty asks first.
 *   - Everything else is FILE-backed, so the affordances are "open the file" and
 *     "delete the file" rather than a bespoke form per kind that would drift from
 *     the format the loader actually accepts. Manifest-backed kinds (MCP
 *     servers, sub-apps) point at `project.yaml`, because that's where they live.
 *
 * Mounted once in App; open state lives in the view store's `overlay` field
 * (see stores/view.ts). Pure REST via the `useConfig` store,
 * fetched on open + on project change; live-updated by the `project-config-update`
 * WS event (a watcher edit, a scaffold, an import, or an authoring chat writing
 * a file all refresh it in place).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileCog,
  RefreshCw,
  Download,
  Upload,
  FolderGit2,
  TriangleAlert,
  Sparkles,
  SquarePen,
  Save,
  Undo2,
} from "lucide-react";
import { ARCHIVE_EXT, ARCHIVE_EXTS, CONFIG_DIR_NAME, resolveWorkflow } from "@dispatch/shared";
import type {
  ConfigSection,
  Project,
  ProjectConfigError,
  WorkflowConfig,
  ShellTranscriptFilter,
} from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { openCodeViewer } from "../monaco/store.js";
import { useProjects } from "../../stores/projects.js";
import { useConfig, useProjectConfig } from "../../stores/config.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useNotices } from "../../stores/notices.js";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { useOverlay } from "../../stores/view.js";
import { WorkflowProfilePicker } from "./WorkflowProfilePicker.js";
import { ConfigSectionPane } from "./ConfigSectionPane.js";
import { sectionItems } from "./configItems.js";
import { SECTIONS } from "./sections.js";
import { ShellFilterPanel } from "../chat/ShellFilterPanel.js";
import { useSettings } from "../../stores/settings.js";

/* ------------------------------------------------------------------ errors */

function ErrorList({ errors }: { errors: ProjectConfigError[] }) {
  if (!errors.length) return null;
  return (
    <div className="rounded-md border border-danger/30 bg-danger-ghost px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-danger [&_svg]:size-3.5">
        <TriangleAlert />
        {errors.length} load {errors.length === 1 ? "error" : "errors"}
      </div>
      <ul className="space-y-0.5">
        {errors.map((e, i) => (
          <li key={i} className="text-xs leading-snug text-muted">
            <span className="cm-mono text-danger/90">[{e.scope}]</span>{" "}
            {e.file ? <span className="cm-mono text-faint">{e.file}: </span> : null}
            {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------- draft */

/**
 * The workflow block a project is currently persisting, normalized so the draft
 * and the saved value are comparable field-by-field. `resolveWorkflow` fills in
 * the profile's implied defaults, which is what makes "did anything change?" an
 * honest question: without it, an untouched project reads as dirty the moment a
 * control renders its effective value.
 */
function savedWorkflow(project: Project | null): WorkflowConfig {
  const r = resolveWorkflow(project);
  return {
    profile: r.profile,
    ...(r.worktreeCmd ? { worktree: r.worktreeCmd } : {}),
    ...(r.shipCmd ? { ship: r.shipCmd } : {}),
    syncMainAfter: r.syncMainAfter,
    memory: r.memory,
    guard: r.guard,
    autoMerge: r.autoMerge,
    mergeMethod: r.mergeMethod,
  };
}

/* ------------------------------------------------------------------ overlay */

export function ProjectConfigView() {
  const { open, close: setClosed } = useOverlay("config");
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const projectId = project?.id ?? null;
  const { result, loading, error } = useProjectConfig(projectId);
  const memories = useProjectMemories(projectId);
  const pushToast = useNotices((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [section, setSection] = useState<ConfigSection>("workflow");
  const fileRef = useRef<HTMLInputElement>(null);

  // The editable draft. null = "no local edits", so anything arriving from the
  // server (a watcher edit, another client) shows through instead of being
  // shadowed by a stale copy — but a draft in progress is never clobbered.
  const [draft, setDraft] = useState<WorkflowConfig | null>(null);
  // null means untouched; undefined is a deliberate reset to app inheritance.
  const [filterDraft, setFilterDraft] = useState<ShellTranscriptFilter | undefined | null>(null);
  const saved = savedWorkflow(project);
  const workflow = draft ?? saved;
  const savedFilter = project?.shellFilter;
  const shellFilter = filterDraft === null ? savedFilter : filterDraft;
  const appShellFilter = useSettings((s) => s.shellFilter);
  const workflowDirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const filterDirty = filterDraft !== null && JSON.stringify(filterDraft) !== JSON.stringify(savedFilter);
  const dirty = workflowDirty || filterDirty;

  const config = result?.config ?? null;
  const errors = result?.errors ?? [];
  const hasDir = !!result?.sourceDir;
  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  // The config dir's own name, so file paths work in a repo that still carries
  // the pre-rename directory.
  const configDirName = useMemo(() => {
    const src = result?.sourceDir;
    if (!src) return CONFIG_DIR_NAME;
    const parts = src.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || CONFIG_DIR_NAME;
  }, [result?.sourceDir]);

  // Fetch on open / project change while open (the WS event keeps it fresh after).
  useEffect(() => {
    if (open && projectId) void useConfig.getState().load(projectId);
  }, [open, projectId]);

  // Switching projects must not carry one project's unsaved edits into another.
  useEffect(() => {
    setDraft(null);
    setFilterDraft(null);
    setConfirmClose(false);
  }, [projectId]);

  const reload = useCallback(() => {
    if (projectId) void useConfig.getState().reload(projectId);
  }, [projectId]);

  const saveWorkflow = useCallback(async () => {
    if (!projectId || !dirty || saving) return;
    setSaving(true);
    try {
      let target: "manifest" | "store" | undefined;
      let manifestPath: string | undefined;
      if (workflowDirty && draft) {
        const out = await api.projectConfig.saveWorkflow(projectId, draft);
        useProjects.getState().upsertProject(out.project);
        target = out.target;
        manifestPath = out.manifestPath;
      }
      if (filterDirty) {
        const out = await api.projectConfig.saveShellFilter(projectId, filterDraft ?? undefined);
        useProjects.getState().upsertProject(out.project);
        target = out.target;
        manifestPath = out.manifestPath;
      }
      setDraft(null);
      setFilterDraft(null);
      setConfirmClose(false);
      pushToast({
        level: "info",
        text:
          target === "manifest"
            ? `Saved to ${manifestPath ?? "project.yaml"}`
            : "Project settings saved",
      });
    } catch (e) {
      pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [projectId, dirty, saving, workflowDirty, draft, filterDirty, filterDraft, pushToast]);

  const discard = useCallback(() => {
    setDraft(null);
    setFilterDraft(null);
    setConfirmClose(false);
  }, []);

  // Escape / backdrop / ✕ all land here; unsaved edits get one confirmation
  // rather than disappearing silently.
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    setDraft(null);
    setClosed();
  }, [dirty]);

  // Open a config file in the editor. Saving there writes it back and the
  // `.dispatch/` watcher reloads the config, refreshing this view in place.
  const openFile = useCallback(
    (rel: string) => {
      if (!project?.repoPath) return;
      openCodeViewer({
        worktreePath: project.repoPath,
        relPath: `${configDirName}/${rel}`,
        mode: "file",
        base: project.defaultBranch || "main",
        editable: true,
      });
    },
    [project, configDirName],
  );

  const deleteItem = useCallback(
    async (rel: string, label: string) => {
      if (!projectId || busy) return;
      setBusy(true);
      try {
        const out = await api.projectConfig.deleteItem(projectId, rel);
        useConfig.getState().set(projectId, out);
        pushToast({ level: "info", text: `Deleted ${label}` });
      } catch (e) {
        pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, pushToast],
  );

  const doExport = useCallback(() => {
    if (!projectId) return;
    // A plain navigation to the export URL triggers the browser download
    // (Content-Disposition: attachment) without leaving the app.
    const a = document.createElement("a");
    a.href = api.projectConfig.exportUrl(projectId);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [projectId]);

  const doScaffold = useCallback(async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const out = await api.projectConfig.scaffold(projectId);
      useConfig.getState().set(projectId, out.result);
      pushToast({
        level: "info",
        text: out.created ? `Scaffolded .dispatch/ (${out.files.length} files)` : "Config reloaded",
      });
    } catch (e) {
      pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, pushToast]);

  const onImportFile = useCallback(
    async (file: File) => {
      if (!projectId) return;
      setBusy(true);
      try {
        const buf = await file.arrayBuffer();
        // btoa over a binary string (chunked to avoid call-stack limits).
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const out = await api.projectConfig.import(projectId, btoa(bin));
        useConfig.getState().set(projectId, out.result);
        pushToast({ level: "info", text: `Imported ${out.files.length} files from ${file.name}` });
      } catch (e) {
        pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, pushToast],
  );

  return (
    <Modal
      open={open}
      onClose={requestClose}
      width={880}
      icon={<FileCog />}
      title="Project config"
      description={project ? `.dispatch/ for ${project.name}` : "No project selected"}
      footer={
        <>
          {error ? (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          ) : dirty ? (
            <span className="mr-auto truncate text-2xs font-medium text-warn">
              Unsaved changes
            </span>
          ) : (
            <span className="mr-auto truncate text-2xs text-faint" title={result?.sourceDir ?? ""}>
              {result?.sourceDir ?? "no .dispatch/ — using .data defaults"}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={`${ARCHIVE_EXTS.join(",")},application/zip`}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onImportFile(f);
            }}
          />
          <Button
            variant="ghost"
            leftIcon={<Upload />}
            disabled={busy || !projectId}
            onClick={() => fileRef.current?.click()}
          >
            Import {ARCHIVE_EXT}
          </Button>
          <Button variant="ghost" leftIcon={<Download />} disabled={!projectId} onClick={doExport}>
            Export {ARCHIVE_EXT}
          </Button>
          {hasDir && (
            <Button
              variant="ghost"
              leftIcon={<SquarePen />}
              disabled={!project?.repoPath}
              onClick={() => openFile("project.yaml")}
            >
              project.yaml
            </Button>
          )}
          <Button
            variant="default"
            leftIcon={loading ? <Spinner size={12} /> : <RefreshCw />}
            disabled={loading || busy || saving || !projectId}
            onClick={reload}
          >
            Reload
          </Button>
          {dirty && (
            <Button variant="ghost" leftIcon={<Undo2 />} disabled={saving} onClick={discard}>
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            leftIcon={saving ? <Spinner size={12} /> : <Save />}
            disabled={!dirty || saving || !projectId}
            onClick={() => void saveWorkflow()}
          >
            Save
          </Button>
        </>
      }
    >
      {!projectId ? (
        <div className="rounded-md border border-dashed border-line px-3 py-10 text-center">
          <FolderGit2 className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-sm text-muted">No active project.</p>
        </div>
      ) : loading && !result ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner size={14} /> Loading config…
        </div>
      ) : (
        <div className="space-y-2.5">
          {confirmClose && (
            <div className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn-ghost px-3 py-2">
              <TriangleAlert className="size-3.5 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-xs text-secondary">
                You have unsaved project settings.
              </span>
              <Button variant="ghost" onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  discard();
                  setClosed();
                }}
              >
                Discard &amp; close
              </Button>
              <Button
                variant="primary"
                leftIcon={saving ? <Spinner size={12} /> : <Save />}
                disabled={saving}
                onClick={() => void saveWorkflow().then(() => setClosed())}
              >
                Save &amp; close
              </Button>
            </div>
          )}
          <ErrorList errors={errors} />

          {!hasDir && !config && (
            <div className="rounded-md border border-dashed border-line px-3 py-4 text-center">
              <FileCog className="mx-auto mb-1.5 size-5 text-faint" />
              <p className="text-sm text-secondary">No .dispatch/ in this repo.</p>
              <p className="mx-auto mt-0.5 max-w-md text-xs text-faint">
                The workflow profile below still applies. Scaffold a committable
                <span className="cm-mono"> .dispatch/</span> to add instructions, agents, skills
                and the rest — and to share them with the repo.
              </p>
              <Button
                className="mt-3"
                variant="primary"
                leftIcon={busy ? <Spinner size={12} /> : <Sparkles />}
                disabled={busy}
                onClick={doScaffold}
              >
                Scaffold .dispatch/
              </Button>
            </div>
          )}

          <div className="flex gap-3">
            {/* Section rail. Counts stay (they're useful at a glance) but they're
                no longer the whole story — the label and blurb carry it. */}
            <nav className="w-[168px] shrink-0 space-y-0.5">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const selected = s.id === section;
                const count =
                  s.id === "workflow" ? null : sectionItems(s.id, config, memories).length;
                return (
                  <button
                    key={s.id}
                    type="button"
                    title={s.blurb}
                    onClick={() => setSection(s.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors [&_svg]:size-3.5",
                      selected
                        ? "bg-accent-ghost text-accent"
                        : "text-secondary hover:bg-panel-2 hover:text-primary",
                    )}
                  >
                    <Icon className={cn("shrink-0", selected ? "text-accent" : "text-muted")} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {s.label}
                    </span>
                    {count !== null && (
                      <Chip tone={count ? "accent" : "muted"} mono>
                        {count}
                      </Chip>
                    )}
                    {s.id === "workflow" && dirty && (
                      <span className="size-1.5 shrink-0 rounded-full bg-warn" />
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="min-w-0 flex-1">
              <ConfigSectionPane
                section={activeSection}
                projectId={projectId}
                config={config}
                memories={memories}
                busy={busy || saving}
                onOpenFile={openFile}
                onDelete={(rel, label) => void deleteItem(rel, label)}
                // The launcher already focused the spawned chat; getting out of
                // the way is all that's left. A dirty workflow draft would be
                // lost, so it holds the dialog open with its usual confirmation.
                onLaunched={() => (dirty ? setConfirmClose(true) : setClosed())}
              >
                {activeSection.id === "workflow" && project && (
                  <div className="space-y-4">
                    <WorkflowProfilePicker
                      value={workflow}
                      onChange={setDraft}
                      fromManifest={hasDir}
                      disabled={saving}
                    />
                    <div className="border-t border-line-soft pt-3">
                      <div className="mb-1 text-xs font-medium text-secondary">Transcript shell</div>
                      <p className="mb-2 text-2xs leading-snug text-faint">
                        Project visibility defaults. Chats inherit this filter until they override it.
                      </p>
                      <ShellFilterPanel
                        value={shellFilter}
                        inherited={appShellFilter}
                        onChange={setFilterDraft}
                        parentLabel="app defaults"
                      />
                    </div>
                  </div>
                )}
              </ConfigSectionPane>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
