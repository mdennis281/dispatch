/**
 * ProjectConfigView — the app-wide, read-only view of a project's self-contained
 * `.claude-manager/` config. Shows exactly what was loaded from disk (source
 * path, instructions, sub-apps, MCP servers, agents, modes, memory count) plus
 * any structured load errors, and offers Reload / Export `.cm` / Import `.cm` /
 * (when absent) Scaffold actions.
 *
 * Mounted once in App; opens on the `cm:open-project-config` window event
 * (command palette / top-bar affordance). Pure REST via the `useConfig` store,
 * fetched on open + on project change; live-updated by the `project-config-update`
 * WS event (a watcher edit, a scaffold, or an import all refresh it in place).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileCog,
  RefreshCw,
  Download,
  Upload,
  ScrollText,
  Boxes,
  Blocks,
  Bot,
  ShieldCheck,
  Brain,
  FolderGit2,
  TriangleAlert,
  Sparkles,
  Wand2,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import type { ProjectConfig, ProjectConfigError } from "@cm/shared";
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
import { OPEN_PROJECT_CONFIG_EVENT } from "./configViewBus.js";

/* ------------------------------------------------------------------ section */

function Section({
  icon: Icon,
  label,
  count,
  children,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line bg-panel-2/40">
      <div className="flex items-center gap-2 px-3 py-2 [&_svg]:size-3.5">
        <Icon className="shrink-0 text-muted" />
        <span className="text-[12px] font-semibold text-primary">{label}</span>
        <Chip tone={count ? "accent" : "muted"} mono>
          {count}
        </Chip>
      </div>
      {count > 0 && children && (
        <div className="space-y-1 border-t border-line-soft px-3 py-2">{children}</div>
      )}
    </div>
  );
}

function Row({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="cm-mono !text-[11px] text-secondary">{title}</span>
      {sub && <span className="truncate text-[10.5px] text-faint">{sub}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ errors */

function ErrorList({ errors }: { errors: ProjectConfigError[] }) {
  if (!errors.length) return null;
  return (
    <div className="rounded-md border border-danger/30 bg-danger-ghost px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-danger [&_svg]:size-3.5">
        <TriangleAlert />
        {errors.length} load {errors.length === 1 ? "error" : "errors"}
      </div>
      <ul className="space-y-0.5">
        {errors.map((e, i) => (
          <li key={i} className="text-[11px] leading-snug text-muted">
            <span className="cm-mono text-danger/90">[{e.scope}]</span>{" "}
            {e.file ? <span className="cm-mono text-faint">{e.file}: </span> : null}
            {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------- config body */

function ConfigBody({ config, memoryCount }: { config: ProjectConfig; memoryCount: number }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Section icon={ScrollText} label="Instructions" count={config.instructions.length}>
        {config.instructions.map((ins, i) => (
          <Row
            key={i}
            title={ins.source === "file" ? (ins.file ?? "file") : "inline text"}
            sub={ins.text.slice(0, 60).replace(/\n/g, " ")}
          />
        ))}
      </Section>
      <Section icon={Boxes} label="Sub-apps" count={config.subApps.length}>
        {config.subApps.map((s) => (
          <Row key={s.id} title={s.id} sub={s.path} />
        ))}
      </Section>
      <Section icon={Blocks} label="MCP servers" count={Object.keys(config.mcpServers).length}>
        {Object.entries(config.mcpServers).map(([name, cfg]) => (
          <Row key={name} title={name} sub={cfg.type ?? "stdio"} />
        ))}
      </Section>
      <Section icon={Bot} label="Agents" count={config.agents.length}>
        {config.agents.map((a) => (
          <Row key={a.id} title={a.id} sub={a.permissionMode} />
        ))}
      </Section>
      <Section icon={ShieldCheck} label="Modes" count={config.modes.length}>
        {config.modes.map((m) => (
          <Row key={m.id} title={m.id} sub={m.permissionMode} />
        ))}
      </Section>
      <Section icon={Wand2} label="Skills" count={config.skills.length}>
        {config.skills.map((s) => (
          <Row key={s.id} title={s.name} sub={s.description} />
        ))}
      </Section>
      <Section icon={Brain} label="Memory" count={memoryCount} />
    </div>
  );
}

/* ------------------------------------------------------------------ overlay */

export function ProjectConfigView() {
  const [open, setOpen] = useState(false);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const projectId = project?.id ?? null;
  const { result, loading, error } = useProjectConfig(projectId);
  const memories = useProjectMemories(projectId);
  const pushToast = useNotices((s) => s.push);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PROJECT_CONFIG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROJECT_CONFIG_EVENT, onOpen);
  }, []);

  // Fetch on open / project change while open (the WS event keeps it fresh after).
  useEffect(() => {
    if (open && projectId) void useConfig.getState().load(projectId);
  }, [open, projectId]);

  const reload = useCallback(() => {
    if (projectId) void useConfig.getState().reload(projectId);
  }, [projectId]);

  // Open the manifest editable in Monaco. Saving writes it back and the server's
  // `.claude-manager/` watcher reloads the config (refreshing this view in place).
  const editYaml = useCallback(() => {
    if (!project?.repoPath) return;
    openCodeViewer({
      worktreePath: project.repoPath,
      relPath: ".claude-manager/project.yaml",
      mode: "file",
      base: project.defaultBranch || "main",
      editable: true,
    });
  }, [project]);

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
        text: out.created ? `Scaffolded .claude-manager/ (${out.files.length} files)` : "Config reloaded",
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

  const config = result?.config ?? null;
  const errors = result?.errors ?? [];
  const hasDir = !!result?.sourceDir;

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      width={720}
      icon={<FileCog />}
      title="Project config"
      description={project ? `.claude-manager/ for ${project.name}` : "No project selected"}
      footer={
        <>
          {error ? (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          ) : (
            <span className="mr-auto truncate text-[10.5px] text-faint" title={result?.sourceDir ?? ""}>
              {result?.sourceDir ?? "no .claude-manager/ — using .data defaults"}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".cm,application/zip"
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
            Import .cm
          </Button>
          <Button variant="ghost" leftIcon={<Download />} disabled={!projectId} onClick={doExport}>
            Export .cm
          </Button>
          {hasDir && (
            <Button
              variant="ghost"
              leftIcon={<SquarePen />}
              disabled={!project?.repoPath}
              onClick={editYaml}
            >
              Edit project.yaml
            </Button>
          )}
          <Button
            variant="default"
            leftIcon={loading ? <Spinner size={12} /> : <RefreshCw />}
            disabled={loading || busy || !projectId}
            onClick={reload}
          >
            Reload
          </Button>
        </>
      }
    >
      {!projectId ? (
        <div className="rounded-md border border-dashed border-line px-3 py-10 text-center">
          <FolderGit2 className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-[12px] text-muted">No active project.</p>
        </div>
      ) : loading && !result ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-muted">
          <Spinner size={14} /> Loading config…
        </div>
      ) : (
        <div className="space-y-2.5">
          <ErrorList errors={errors} />
          {config ? (
            <ConfigBody config={config} memoryCount={memories.length} />
          ) : (
            <div className="rounded-md border border-dashed border-line px-3 py-8 text-center">
              <FileCog className="mx-auto mb-1.5 size-5 text-faint" />
              <p className="text-[12px] text-secondary">
                {hasDir
                  ? "A .claude-manager/ exists but its manifest could not be loaded."
                  : "No .claude-manager/ in this repo."}
              </p>
              <p className="mx-auto mt-0.5 max-w-md text-[11px] text-faint">
                {hasDir
                  ? "Fix the errors above and Reload."
                  : "This project runs off its .data defaults. Scaffold a committable .claude-manager/ derived from the current config."}
              </p>
              {!hasDir && (
                <Button
                  className={cn("mt-3")}
                  variant="primary"
                  leftIcon={busy ? <Spinner size={12} /> : <Sparkles />}
                  disabled={busy}
                  onClick={doScaffold}
                >
                  Scaffold .claude-manager/
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
