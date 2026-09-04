/**
 * ProjectSettingsView — the project's config dir, section by section.
 *
 * Two rewrites in its history, and this is the second. The first killed a wall
 * of counts ("Modes: 2", "Skills: 0") that told you what existed and nothing
 * about what any of it WAS, replacing it with a section rail plus a detail pane.
 * That layout was right and the container was wrong: an 880px `Modal` with a
 * fixed 168px rail and no small-screen fallback, so on a phone the rail and the
 * pane split ~340px between them and neither was usable.
 *
 * So it's a page now (see SettingsShell for the responsive behaviour). The
 * editing rules that shaped it are unchanged:
 *
 *   - The workflow block is EDITABLE and held as a draft behind an explicit
 *     Save. A settings surface that writes on every click gives you nothing to
 *     confirm and no way to back out — and a manifest-backed project can only be
 *     saved correctly as a whole block, since `project.yaml` overrides `.data`
 *     on every config reload.
 *   - Everything else is FILE-backed, so the affordances are "open the file" and
 *     "delete the file" rather than a bespoke form per kind that would drift
 *     from the format the loader actually accepts. Manifest-backed kinds (MCP
 *     servers, sub-apps) point at `project.yaml`, because that's where they live.
 *
 * What DID change with the container: the draft lives in a store rather than in
 * this component. A modal had one exit to intercept with an "unsaved changes"
 * confirmation; a page has none, so instead of asking, it keeps the edits — the
 * rail's warn dot and the save bar are still there when you come back.
 *
 * Pure REST via the `useConfig` store, fetched on mount + on project change;
 * live-updated by the `project-config-update` WS event (a watcher edit, a
 * scaffold, an import, or an authoring chat writing a file all refresh it).
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
  FolderInput,
  FolderOutput,
} from "lucide-react";
import {
  ARCHIVE_EXT,
  ARCHIVE_EXTS,
  authorReviewerRoster,
  CONFIG_DIR_NAMES,
  resolveWorkflow,
} from "@dispatch/shared";
import type {
  ConfigSection,
  Project,
  ProjectConfigError,
  ProjectConfigLocation,
  WorkflowConfig,
} from "@dispatch/shared";
import { InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { openCodeViewer } from "../monaco/store.js";
import { useProjects } from "../../stores/projects.js";
import { useConfig, useProjectConfig } from "../../stores/config.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useNotices } from "../../stores/notices.js";
import { useSettings } from "../../stores/settings.js";
import { useView } from "../../stores/view.js";
import { useProjectSettingsDraft } from "../../stores/settingsDraft.js";
import { api } from "../../lib/api.js";
import { WorkflowProfilePicker } from "./WorkflowProfilePicker.js";
import { ReviewerSection } from "./ReviewerSection.js";
import { ConfigSectionPane } from "./ConfigSectionPane.js";
import { sectionItems } from "./configItems.js";
import { SECTIONS } from "./sections.js";
import { ShellFilterPanel } from "../chat/ShellFilterPanel.js";
import { SettingsShell } from "../settings/SettingsShell.js";

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
  const pr = prBaseline(project);
  return {
    profile: r.profile,
    ...(r.worktreeCmd ? { worktree: r.worktreeCmd } : {}),
    ...(r.shipCmd ? { ship: r.shipCmd } : {}),
    syncMainAfter: r.syncMainAfter,
    memory: r.memory,
    guard: r.guard,
    autoMerge: r.autoMerge,
    mergeMethod: r.mergeMethod,
    pr: {
      // The ROSTER, not the asked list: a project whose manifest mutes a
      // reviewer would otherwise compare its saved value against a baseline that
      // had already dropped that row, and read as dirty the moment it rendered.
      reviewers: authorReviewerRoster(pr.reviewerRoster),
      requireReview: pr.requireReview,
      requireChecks: pr.requireChecks,
      draft: pr.draft,
      reviewAgent: {
        enabled: pr.reviewAgent.enabled,
        identity: pr.reviewAgent.identity,
        effort: pr.reviewAgent.effort,
        maxRounds: pr.reviewAgent.maxRounds,
        post: pr.reviewAgent.post,
        ...(pr.reviewAgent.model ? { model: pr.reviewAgent.model } : {}),
        ...(pr.reviewAgent.agentId ? { agentId: pr.reviewAgent.agentId } : {}),
        ...(pr.reviewAgent.instructions ? { instructions: pr.reviewAgent.instructions } : {}),
      },
    },
  };
}

/**
 * The `pr` half of the baseline, resolved as though the project were already on
 * the `review` rung.
 *
 * `resolveWorkflow` clamps `pr` INERT on the lower rungs — correctly, because no
 * PR is opened there — but a baseline built from that clamp reports a project's
 * AUTHORED reviewer settings as off the moment its profile is anything else, and
 * then a Save writes the clamp back over them. The Reviewer pane says these
 * settings are kept either way and take effect when the profile is; this is what
 * makes that true.
 *
 * `login` is deliberately not carried through: the server overlays it from the
 * stored credential and it is not part of the authored block.
 */
function prBaseline(project: Project | null) {
  return resolveWorkflow({
    ...project,
    workflow: { ...project?.workflow, profile: "review" },
  }).pr;
}

/* --------------------------------------------------------------------- page */

export function ProjectSettingsView() {
  const section = useView((s) => s.projectSection);
  const setSection = useView((s) => s.setProjectSection);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const projectId = project?.id ?? null;
  const { result, loading, error } = useProjectConfig(projectId);
  const memories = useProjectMemories(projectId);
  const pushToast = useNotices((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const draft = useProjectSettingsDraft((s) => s.workflow);
  const filterDraft = useProjectSettingsDraft((s) => s.shellFilter);
  const setDraft = useProjectSettingsDraft((s) => s.setWorkflow);
  const setFilterDraft = useProjectSettingsDraft((s) => s.setShellFilter);
  const discard = useProjectSettingsDraft((s) => s.discard);

  const saved = savedWorkflow(project);
  const workflow = draft ?? saved;
  const savedFilter = project?.shellFilter;
  const shellFilter = filterDraft === null ? savedFilter : filterDraft;
  const appShellFilter = useSettings((s) => s.shellFilter);
  const workflowDirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const filterDirty =
    filterDraft !== null && JSON.stringify(filterDraft) !== JSON.stringify(savedFilter);
  const dirty = workflowDirty || filterDirty;

  const config = result?.config ?? null;
  const errors = result?.errors ?? [];
  const hasDir = !!result?.sourceDir;
  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  // The config dir split into the directory that CONTAINS it plus its own name.
  // Both halves have to come off `sourceDir`: the dir may be the repo's
  // `.dispatch/` (or a pre-rename `.claude-manager/`), or it may be outside the
  // repo altogether — in which case composing paths from `repoPath` names files
  // that do not exist. Splitting the resolved path covers all three without this
  // component having to know which one it is looking at.
  const configPath = useMemo(() => {
    const src = result?.sourceDir;
    if (!src) return null;
    const norm = src.replace(/\\/g, "/").replace(/\/+$/, "");
    const cut = norm.lastIndexOf("/");
    if (cut <= 0) return null;
    return { root: norm.slice(0, cut), name: norm.slice(cut + 1) };
  }, [result?.sourceDir]);
  // Whether the config sits inside the working tree — i.e. whether git will see
  // an edit to it. Drives the wording and the location control, not behaviour.
  const inRepo = (CONFIG_DIR_NAMES as readonly string[]).includes(configPath?.name ?? "");

  // Fetch on mount / project change (the WS event keeps it fresh after).
  useEffect(() => {
    if (projectId) void useConfig.getState().load(projectId);
  }, [projectId]);

  // Switching projects must not carry one project's unsaved edits into another.
  useEffect(() => {
    useProjectSettingsDraft.getState().bind(projectId);
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
      discard();
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
  }, [projectId, dirty, saving, workflowDirty, draft, filterDirty, filterDraft, discard, pushToast]);

  // Open a config file in the editor. Saving there writes it back and the
  // config watcher reloads it, refreshing this view in place.
  const openFile = useCallback(
    (rel: string) => {
      if (!configPath) return;
      openCodeViewer({
        worktreePath: configPath.root,
        relPath: `${configPath.name}/${rel}`,
        mode: "file",
        base: project?.defaultBranch || "main",
        editable: true,
      });
    },
    [project, configPath],
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
        text: out.created
          ? `Created config (${out.files.length} files) in ${out.sourceDir}`
          : "Config reloaded",
      });
    } catch (e) {
      pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, pushToast]);

  // Move the config between the repo and the install's own dir. The server
  // copies the tree, so this is a move rather than a re-point at an empty
  // directory — but it deliberately leaves the source behind, and going repo →
  // external those files may still be tracked, so say so rather than letting
  // someone assume the working tree is clean now.
  const setLocation = useCallback(
    async (location: ProjectConfigLocation) => {
      if (!projectId || busy) return;
      setBusy(true);
      try {
        const out = await api.projectConfig.setLocation(projectId, location);
        useConfig.getState().set(projectId, out.result);
        pushToast({
          level: "info",
          text: out.moved
            ? `Config moved to ${out.sourceDir} — ${out.files.length} files copied. ` +
              `The originals are still in ${out.from}.`
            : `Config location set to ${location}.`,
        });
      } catch (e) {
        pushToast({ level: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, pushToast],
  );

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

  if (!projectId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-center">
        <FolderGit2 className="mb-2 size-6 text-faint" />
        <p className="text-base font-medium text-secondary">No project selected</p>
        <p className="mt-0.5 text-xs text-muted">Pick a project to configure it.</p>
      </div>
    );
  }

  return (
    <SettingsShell<ConfigSection>
      icon={<FileCog />}
      title="Project config"
      subtitle={project ? `Dispatch config for ${project.name}` : undefined}
      sections={SECTIONS.map((s) => ({
        id: s.id,
        icon: s.icon,
        label: s.label,
        blurb: s.blurb,
        count: s.id === "workflow" ? null : sectionItems(s.id, config, memories).length,
        // Both panes edit ONE draft behind ONE Save, so the warn dot belongs on
        // both. Marking only Workflow meant reviewer edits looked saved from the
        // rail — the section you were just editing was the one not flagged.
        dirty: (s.id === "workflow" || s.id === "reviewer") && dirty,
      }))}
      active={section}
      onSelect={setSection}
      actions={
        <Button
          variant="default"
          leftIcon={loading ? <Spinner size={12} /> : <RefreshCw />}
          disabled={loading || busy || saving}
          onClick={reload}
        >
          Reload
        </Button>
      }
      // Page-level, not section-level: importing an archive replaces config
      // across every section, so parking it under the rail (which at `sm` IS
      // the index page) says so better than a toolbar button on all eight.
      indexFooter={
        <div className="space-y-1">
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
            className="w-full justify-start"
            leftIcon={<Upload />}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Import {ARCHIVE_EXT}
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            leftIcon={<Download />}
            onClick={doExport}
          >
            Export {ARCHIVE_EXT}
          </Button>
          {hasDir && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              leftIcon={<SquarePen />}
              disabled={!project?.repoPath}
              onClick={() => openFile("project.yaml")}
            >
              project.yaml
            </Button>
          )}
          {hasDir && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              leftIcon={inRepo ? <FolderOutput /> : <FolderInput />}
              disabled={busy}
              onClick={() => void setLocation(inRepo ? "external" : "repo")}
              title={
                inRepo
                  ? "Copy this config out of the repo, so nothing Dispatch writes has to be committed"
                  : "Copy this config into the repo, so it can be committed and shared with the team"
              }
            >
              {inRepo ? "Move out of repo" : "Move into repo"}
            </Button>
          )}
          <p className="px-2 pt-1 text-2xs leading-snug text-faint" title={result?.sourceDir ?? ""}>
            {result?.sourceDir ?? "no config dir — using .data defaults"}
          </p>
          {hasDir && (
            <p className="px-2 text-2xs leading-snug text-faint">
              {inRepo ? "Committed with the repo." : "Private to this install; never committed."}
            </p>
          )}
        </div>
      }
      footer={
        error || dirty ? (
          <>
            {error ? (
              <div className="mr-auto min-w-0 flex-1">
                <InlineError message={error} />
              </div>
            ) : (
              <span className="mr-auto truncate text-2xs font-medium text-warn">
                Unsaved changes
              </span>
            )}
            {dirty && (
              <>
                <Button variant="ghost" leftIcon={<Undo2 />} disabled={saving} onClick={discard}>
                  Discard
                </Button>
                <Button
                  variant="primary"
                  leftIcon={saving ? <Spinner size={12} /> : <Save />}
                  disabled={saving}
                  onClick={() => void saveWorkflow()}
                >
                  Save
                </Button>
              </>
            )}
          </>
        ) : null
      }
    >
      {loading && !result ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner size={14} /> Loading config…
        </div>
      ) : (
        <div className="space-y-3">
          <ErrorList errors={errors} />

          {!hasDir && !config && (
            <div className="rounded-md border border-dashed border-line px-3 py-4 text-center">
              <FileCog className="mx-auto mb-1.5 size-5 text-faint" />
              <p className="text-sm text-secondary">No config dir for this project yet.</p>
              <p className="mx-auto mt-0.5 max-w-md text-xs text-faint">
                The workflow profile still applies. Create one to add instructions, agents,
                skills and the rest. It goes outside the repo by default, so nothing here has to
                be committed — move it in later if you want to share it with the team.
              </p>
              <Button
                className="mt-3"
                variant="primary"
                leftIcon={busy ? <Spinner size={12} /> : <Sparkles />}
                disabled={busy}
                onClick={doScaffold}
              >
                Create config
              </Button>
            </div>
          )}

          <ConfigSectionPane
            section={activeSection}
            projectId={projectId}
            config={config}
            memories={memories}
            busy={busy || saving}
            onOpenFile={openFile}
            onDelete={(rel, label) => void deleteItem(rel, label)}
            // The launcher already focused the spawned chat, which switched the
            // main area to it — nothing left for this page to do. Unlike the
            // modal it replaces, a dirty draft isn't at risk: it lives in a
            // store and is still here when you come back.
            onLaunched={() => useView.getState().setView("chat")}
          >
            {activeSection.id === "workflow" && project && (
              <div className="space-y-4">
                <WorkflowProfilePicker
                  value={workflow}
                  onChange={setDraft}
                  fromManifest={hasDir}
                inRepo={inRepo}
                  inRepo={inRepo}
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

            {/* Reads and writes the SAME workflow draft as the section above —
                the reviewer is `workflow.pr.reviewAgent`, so both save through
                one manifest write. Only the account half talks to the server on
                its own, because a secret is not a draft. */}
            {activeSection.id === "reviewer" && project && (
              <ReviewerSection
                value={workflow}
                onChange={setDraft}
                projectId={projectId}
                fromManifest={hasDir}
                disabled={saving}
              />
            )}
          </ConfigSectionPane>
        </div>
      )}
    </SettingsShell>
  );
}
