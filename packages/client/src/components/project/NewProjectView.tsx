/**
 * NewProjectView — the full-bleed "set up a project" page.
 *
 * This replaced a 560px dialog, and the swap was about what the flow is FOR
 * rather than about roominess. A dialog asks you to fill in a record. This asks
 * you to start a project: you name it, you watch the config it implies take
 * shape beside you, and you hand the rest to an agent that can read the repo you
 * pointed at. That's two halves of one job, and the second half only makes sense
 * if you can see the first half's output — hence form left, `project.yaml` right.
 *
 * Three things carry the page:
 *
 *   - **Derivation.** Type a name, get a directory. Every field that can be
 *     inferred from another is, and stops the moment you correct it (see
 *     `newProjectDraft`). The form should be a name and a glance, not a form.
 *   - **A live manifest.** The right pane is `renderManifestYaml` — the exact
 *     function the server writes the file with. What you read is what lands.
 *   - **A hand-off, not a finish line.** "Finish with AI" saves the little the
 *     form knows and opens a chat briefed to do the rest: find the sub-apps,
 *     read the scripts, write the instructions. The form deliberately doesn't
 *     ask for what an agent can read off disk in a minute.
 *
 * The page also has to know things a browser can't: whether the directory
 * exists, whether it's already a repo, whether it has code in it. That's the
 * `/api/fs/probe` call behind the status line under the path field — and it's
 * what turns "create" into either adopting a checkout or `git init`-ing a new
 * one, said out loud before you press anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  FileCog,
  FolderGit2,
  FolderPlus,
  Info,
  Plus,
  Sparkles,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import {
  CONFIG_DIR_NAME,
  MANIFEST_FILE,
  projectToManifest,
  renderManifestYaml,
  type WorkflowConfig,
} from "@dispatch/shared";
import { Field, TextInput, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { Spinner } from "../ui/Spinner.js";
import { WorkflowProfilePicker } from "../config/WorkflowProfilePicker.js";
import { TaskLauncher } from "../tasks/TaskLauncher.js";
import { ManifestPreview } from "./ManifestPreview.js";
import { api, type PathProbe } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { useProjects } from "../../stores/projects.js";
import { useNotices } from "../../stores/notices.js";
import { useView } from "../../stores/view.js";
import {
  DEFAULT_WORKTREE_ROOT,
  draftReady,
  draftToProject,
  emptyDraft,
  emptySubApp,
  resolvedWorktreeRoot,
  withName,
  type NewProjectDraft,
  type SubAppDraft,
} from "./newProjectDraft.js";

/* ------------------------------------------------------------------ pieces */

/** A titled block of the form. Sections, not a wall of inputs. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel className="px-0">{title}</SectionLabel>
        {hint && <span className="min-w-0 text-[10.5px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** Tone of the line under the path field. */
type ProbeTone = "info" | "ok" | "warn";

/**
 * What the probe means, in a sentence.
 *
 * Every branch here is a genuinely different setup, and saying which one you're
 * in BEFORE the button is pressed is the whole point: "this directory doesn't
 * exist yet — it'll be created and initialized as a git repo" is information you
 * want while you can still change the path.
 *
 * It reports, it doesn't decide. Whether `git init` actually runs is settled
 * server-side at create time, because this verdict is as old as the last
 * keystroke and the disk can move underneath it.
 */
function describeProbe(probe: PathProbe | null): { tone: ProbeTone; text: string } {
  if (!probe) return { tone: "info", text: "Checking…" };
  // A relative path resolves against the SERVER's working directory, which is
  // never what someone typing a project directory meant — and it would put a new
  // repo inside the Dispatch install. Refused, with the resolution shown so the
  // reason is obvious.
  if (!probe.absolute) {
    return {
      tone: "warn",
      text: `Use an absolute path — this one resolves against the server, to ${probe.path}.`,
    };
  }
  if (!probe.exists) {
    // `repoRoot` is set for a path that doesn't exist yet but sits inside a repo:
    // creating it would nest a second repo inside the first.
    if (probe.repoRoot) {
      return {
        tone: "ok",
        text: `Inside the existing repo at ${probe.repoRoot} — that repo is used as-is; no new one is created here.`,
      };
    }
    return {
      tone: "info",
      text:
        "Doesn't exist yet — it'll be created here and initialized as a git repo" +
        // `parentExists` is the honest signal: `existingParent` is non-null
        // whenever ANY ancestor exists, which is nearly always.
        (probe.parentExists
          ? "."
          : probe.existingParent
            ? `, along with the folders under ${probe.existingParent}.`
            : ". Its parent folders don't exist and can't be created — check the drive."),
    };
  }
  if (!probe.isDirectory) {
    return { tone: "warn", text: "That's a file, not a directory. Pick a folder." };
  }
  if (probe.dispatchConfig) {
    return {
      tone: "ok",
      text: "This repo already carries a Dispatch config — it wins over this form, so the fields it owns are read from the file instead.",
    };
  }
  if (probe.isGit) {
    const nested = probe.repoRoot && probe.repoRoot !== probe.path;
    if (nested) {
      return {
        tone: "ok",
        text: `Inside the existing repo at ${probe.repoRoot} — that repo is used as-is; no new one is created here.`,
      };
    }
    return {
      tone: "ok",
      text: probe.empty
        ? "An empty git repo — the agent will set it up from scratch."
        : "An existing git repo. Nothing here gets restructured; the agent reads it.",
    };
  }
  return {
    tone: "info",
    text: probe.empty
      ? "An empty folder — `git init` will run here, since worktrees and diffs need a repo."
      : "A folder with files but no git repo. `git init` will run here (it only adds `.git/`); nothing else is touched.",
  };
}

const TONE_CLS: Record<ProbeTone, string> = {
  info: "text-faint",
  ok: "text-success",
  warn: "text-warn",
};

const TONE_ICON: Record<ProbeTone, typeof Info> = {
  info: Info,
  ok: Check,
  warn: TriangleAlert,
};

/* -------------------------------------------------------------------- page */

export function NewProjectView() {
  const setView = useView((s) => s.setView);
  const pushToast = useNotices((s) => s.push);

  const [draft, setDraft] = useState<NewProjectDraft>(emptyDraft);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [probe, setProbe] = useState<PathProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where this human keeps projects, learned from the ones they already have.
  // Until it arrives the name→path derivation has no root to hang off, so the
  // path field simply stays empty rather than suggesting something wrong.
  useEffect(() => {
    let live = true;
    void api.fs
      .roots()
      .then((r) => {
        if (!live) return;
        setProjectsRoot(r.projectsRoot);
        // A name typed before the roots landed still gets its path.
        setDraft((d) => (d.name && !d.repoPath ? withName(d, d.name, r.projectsRoot) : d));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Probe the path, debounced. Every keystroke in a path field is a different
  // question for the disk, but only the one you stop typing on matters.
  const probeSeq = useRef(0);
  useEffect(() => {
    const path = draft.repoPath.trim();
    if (!path) {
      setProbe(null);
      setProbing(false);
      return;
    }
    setProbing(true);
    const seq = ++probeSeq.current;
    const t = setTimeout(() => {
      void api.fs
        .probe(path)
        .then((p) => {
          // Out-of-order responses would flash the wrong verdict; only the
          // newest request is allowed to write.
          if (seq !== probeSeq.current) return;
          setProbe(p);
          setProbing(false);
        })
        .catch(() => {
          if (seq !== probeSeq.current) return;
          setProbe(null);
          setProbing(false);
        });
    }, 220);
    return () => clearTimeout(t);
  }, [draft.repoPath]);

  // Adopting a repo that already has a manifest: show ITS values, because those
  // are the ones the project will have — the loader merges the manifest over the
  // stored record, so a disabled field still holding whatever was typed before
  // would describe a project that isn't about to exist.
  const adoptedName = probe?.dispatchName ?? null;
  const adoptedWorktreeRoot = probe?.dispatchWorktreeRoot ?? null;
  useEffect(() => {
    if (!adoptedName && !adoptedWorktreeRoot) return;
    setDraft((d) => {
      const next = {
        ...d,
        ...(adoptedName ? { name: adoptedName } : {}),
        ...(adoptedWorktreeRoot ? { worktreeRoot: adoptedWorktreeRoot } : {}),
      };
      return next.name === d.name && next.worktreeRoot === d.worktreeRoot ? d : next;
    });
  }, [adoptedName, adoptedWorktreeRoot]);

  const patch = (p: Partial<NewProjectDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchRow = (key: string, p: Partial<SubAppDraft>) =>
    setDraft((d) => ({
      ...d,
      subApps: d.subApps.map((r) => (r.key === key ? { ...r, ...p } : r)),
    }));

  const ready = draftReady(draft);
  const verdict = describeProbe(probe);
  // Only a SETTLED verdict blocks. Mid-probe the verdict still describes the
  // previous path, and a button that disables itself on a stale answer is worse
  // than one that lets the server say no.
  const blocked = !probing && verdict.tone === "warn";
  const VerdictIcon = TONE_ICON[verdict.tone];

  /**
   * The repo brought its own committed `.dispatch/project.yaml`.
   *
   * That file is the source of truth: the loader merges it OVER the stored
   * record on every config load, so `name`, `worktreeRoot`, `workflow` and
   * `subApps` come from it no matter what this form sends. Collecting those
   * answers anyway and dropping them on save is the worst version of this — so
   * the controls it owns go read-only and the preview shows the real file.
   */
  const adoptedConfig = !probing ? (probe?.dispatchConfig ?? null) : null;
  /** Marks the fields the repo's own manifest owns, wherever one is in force. */
  const ownedHint = adoptedConfig ? "from project.yaml" : undefined;

  // The live manifest — the same two functions the server writes the file with.
  // An empty name renders as an empty name (`name: ""`) rather than a stand-in:
  // this pane's whole claim is that it shows the file, and a made-up default
  // would be the one line on it that isn't true. When the repo already has a
  // manifest, the file it shows is that one, verbatim.
  const draftYaml = useMemo(
    () => renderManifestYaml(projectToManifest(draftToProject(draft))),
    [draft],
  );
  const yaml = adoptedConfig ?? draftYaml;

  // Where task worktrees actually land, and whether that's inside the checkout —
  // which is what decides whether the `.gitignore` advice applies at all.
  const resolvedWorktree = resolvedWorktreeRoot(draft.repoPath, draft.worktreeRoot);
  const repoPrefix = draft.repoPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const worktreeInsideRepo = !!repoPrefix && resolvedWorktree.startsWith(`${repoPrefix}/`);

  const configRoot = (probe?.repoRoot ?? draft.repoPath.trim()).replace(/\/+$/, "");
  const manifestPath = configRoot
    ? `${configRoot}/${CONFIG_DIR_NAME}/${MANIFEST_FILE}`
    : `${CONFIG_DIR_NAME}/${MANIFEST_FILE}`;

  /**
   * Save the project exactly as the form has it — no more. Shared by both exits:
   * the AI hand-off calls it to get a project id to launch into, and "Create
   * without AI" calls it on its own. Either way what gets stored is the draft,
   * so the manifest on disk matches the preview that was on screen.
   *
   * Exactly one project, always carrying the CURRENT draft. Both of those need
   * saying, because "Finish with AI" is two steps and only the second one can
   * fail on its own:
   *
   *   - A second call while the first POST is still in flight (the other button
   *     is still live at that moment) awaits the same promise instead of
   *     creating a twin at the same path.
   *   - A call after one already succeeded — the retry after a failed launch —
   *     UPDATES that project rather than skipping the write. Skipping was the
   *     tempting version and it's wrong: you fix the thing the error was about,
   *     press the button again, and the fix never reaches the server while the
   *     preview beside you keeps showing it.
   */
  const createdRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<string> | null>(null);
  const createProject = useCallback(async (): Promise<string> => {
    if (inFlightRef.current) return inFlightRef.current;
    const body = draftToProject(draft);
    const run = (async () => {
      const existing = createdRef.current;
      const saved = existing
        ? await api.projects.update(existing, body)
        : await api.projects.create({
            ...body,
            // Always asked for; the server only acts when the path isn't inside
            // a repo yet, so this can't disturb a checkout you're adopting.
            initRepo: true,
          });
      createdRef.current = saved.id;
      useProjects.getState().upsertProject(saved);
      useProjects.getState().setActiveProject(saved.id);
      return saved.id;
    })();
    inFlightRef.current = run;
    setCreating(true);
    try {
      return await run;
    } finally {
      inFlightRef.current = null;
      setCreating(false);
    }
  }, [draft]);

  const createOnly = useCallback(async () => {
    if (!ready || creating || blocked) return;
    setError(null);
    try {
      await createProject();
      pushToast({ level: "info", text: `Created ${draft.name.trim()}` });
      setView("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ready, creating, blocked, createProject, draft.name, pushToast, setView]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      {/* page header — the only chrome on this screen besides the top bar */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <IconButton tip="Back" onClick={() => setView("chat")}>
          <ArrowLeft />
        </IconButton>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
          <FolderPlus />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-semibold text-primary">New project</h1>
          <p className="mt-px truncate text-[11px] text-muted">
            Name it and point it at a directory — an agent finishes the rest.
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------------ form */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="cm-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {/* The controls stop at a readable measure even when the column
                doesn't — a 900px-wide text input is worse, not better. */}
            <div className="mx-auto max-w-[640px] space-y-6">
              <Section title="Identity" hint="the path follows the name until you edit it">
                <Field label="Name" required={!adoptedConfig} hint={ownedHint}>
                  <TextInput
                    autoFocus
                    value={draft.name}
                    disabled={!!adoptedConfig}
                    onChange={(e) =>
                      setDraft((d) => withName(d, e.target.value, projectsRoot))
                    }
                    placeholder="Acme Billing"
                  />
                </Field>

                <Field
                  label="Project directory"
                  required
                  hint={draft.touched.repoPath ? "edited" : "auto"}
                >
                  <TextInput
                    mono
                    value={draft.repoPath}
                    onChange={(e) =>
                      patch({
                        repoPath: e.target.value,
                        touched: { ...draft.touched, repoPath: true },
                      })
                    }
                    placeholder={projectsRoot ? `${projectsRoot}/acme-billing` : "…/acme-billing"}
                  />
                </Field>

                {draft.repoPath.trim() && (
                  <div
                    className={cn(
                      "flex items-start gap-1.5 text-[11px] leading-snug [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0",
                      TONE_CLS[probing ? "info" : verdict.tone],
                    )}
                  >
                    {probing ? <Spinner size={12} /> : <VerdictIcon />}
                    <span className="min-w-0">{probing ? "Checking…" : verdict.text}</span>
                  </div>
                )}

                {/* The repo's committed manifest overrides the stored record on
                    every config load, so the fields it owns can't be answered
                    here — and a form that took the answers anyway and dropped
                    them on save would be the worst version of this. They go
                    read-only, and the pane on the right shows the real file. */}
                {adoptedConfig && (
                  <div className="flex items-start gap-1.5 rounded-md border border-accent-line bg-accent-ghost px-2.5 py-2 text-[11px] leading-snug text-secondary [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
                    <FileCog className="text-accent" />
                    <span className="min-w-0">
                      Name, worktree root, workflow and apps come from this repo&rsquo;s committed{" "}
                      <span className="cm-mono">project.yaml</span> — shown on the right, and left
                      exactly as it is. Change them there (or in Project config) once the project
                      exists.
                    </span>
                  </div>
                )}
              </Section>

              <Section title="Git">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Default branch" hint="diff / PR base">
                    <TextInput
                      mono
                      value={draft.defaultBranch}
                      onChange={(e) =>
                        patch({
                          defaultBranch: e.target.value,
                          touched: { ...draft.touched, defaultBranch: true },
                        })
                      }
                      placeholder="main"
                    />
                  </Field>
                  <Field
                    label="Worktree root"
                    required={!adoptedConfig}
                    hint={ownedHint ?? "relative to the repo"}
                  >
                    <TextInput
                      mono
                      value={draft.worktreeRoot}
                      disabled={!!adoptedConfig}
                      onChange={(e) =>
                        patch({
                          worktreeRoot: e.target.value,
                          touched: { ...draft.touched, worktreeRoot: true },
                        })
                      }
                      placeholder={DEFAULT_WORKTREE_ROOT}
                    />
                  </Field>
                </div>
                <p className="text-[10.5px] leading-snug text-faint">
                  One directory per repo holding a subdirectory per branch — the convention
                  worktree tooling has settled on.{" "}
                  {/* The .gitignore advice only applies to a root that actually
                      lands inside the checkout; for a sibling or absolute root
                      git never sees it, and saying otherwise is noise. */}
                  {worktreeInsideRepo ? (
                    <>
                      Keeping it inside the repo makes the project one folder you can move or
                      delete as a unit; add{" "}
                      <span className="cm-mono">{draft.worktreeRoot || DEFAULT_WORKTREE_ROOT}</span>{" "}
                      to <span className="cm-mono">.gitignore</span>.
                    </>
                  ) : (
                    <>Kept outside the repo, so git never sees it.</>
                  )}
                  {draft.repoPath.trim() && (
                    <>
                      {" "}
                      Task worktrees land in{" "}
                      <span className="cm-mono text-muted">{resolvedWorktree}</span>.
                    </>
                  )}
                </p>
              </Section>

              <Section title="Workflow" hint="how change ships here">
                {/* `fromManifest` off: its footnote is about editing a file
                    that already exists ("your comments and key order are
                    preserved"), and here the file doesn't exist yet — the
                    preview beside it says where this lands far better. */}
                <WorkflowProfilePicker
                  value={draft.workflow}
                  onChange={(w: WorkflowConfig) => patch({ workflow: w })}
                  fromManifest={false}
                  disabled={creating || !!adoptedConfig}
                />
              </Section>

              <Section
                title="Apps"
                hint={ownedHint ?? "optional — the agent finds these by reading the repo"}
              >
                <div className={cn("space-y-1.5", adoptedConfig && "pointer-events-none opacity-50")}>
                  {draft.subApps.map((r) => (
                    <div
                      key={r.key}
                      className="grid grid-cols-[1fr_1.3fr_1.2fr_0.7fr_auto] items-center gap-1.5"
                    >
                      <TextInput
                        value={r.name}
                        onChange={(e) => patchRow(r.key, { name: e.target.value })}
                        placeholder="web"
                      />
                      <TextInput
                        mono
                        value={r.path}
                        onChange={(e) => patchRow(r.key, { path: e.target.value })}
                        placeholder="apps/web"
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
                          setDraft((d) => ({
                            ...d,
                            subApps:
                              d.subApps.length > 1
                                ? d.subApps.filter((x) => x.key !== r.key)
                                : [emptySubApp()],
                          }))
                        }
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="subtle"
                    leftIcon={<Plus />}
                    disabled={!!adoptedConfig}
                    onClick={() =>
                      setDraft((d) => ({ ...d, subApps: [...d.subApps, emptySubApp()] }))
                    }
                  >
                    Add app
                  </Button>
                  <span className="text-[10.5px] text-faint">
                    Name + path are required per row; empty rows are ignored.
                  </span>
                </div>
              </Section>
            </div>
          </div>

          {/* ------------------------------------------------------- hand-off */}
          <div className="shrink-0 border-t border-line bg-surface px-5 py-3.5 [&>*]:mx-auto [&>*]:max-w-[640px]">
            <div className="mb-2 flex items-center gap-2 [&_svg]:size-3.5">
              <Sparkles className="shrink-0 text-accent" />
              <span className="text-[12px] font-semibold text-primary">Finish with AI</span>
              <span className="ml-auto min-w-0 truncate text-[10.5px] text-faint">
                saves this config, then opens a chat that completes it
              </span>
            </div>
            {error && (
              <div className="mb-2">
                <InlineError message={error} />
              </div>
            )}
            <TaskLauncher
              taskId="project:setup"
              projectId={null}
              resolveProjectId={createProject}
              submitLabel="Finish with AI"
              bare
              dense
              disabled={creating}
              blockedReason={
                !ready
                  ? "Give the project a name and a directory to enable this."
                  : blocked
                    ? verdict.text
                    : undefined
              }
              secondary={
                <Button
                  variant="default"
                  leftIcon={creating ? <Spinner size={12} /> : <FolderGit2 />}
                  disabled={!ready || creating || blocked}
                  onClick={() => void createOnly()}
                >
                  Create without AI
                </Button>
              }
              onLaunched={() => setView("chat")}
            />
          </div>
        </div>

        {/* ------------------------------------------------------------- yaml */}
        {/* Sized as a companion, not a co-equal: the file is short, and giving
            it more than half the window just makes it look mostly empty. */}
        <ManifestPreview
          yaml={yaml}
          path={manifestPath}
          existing={!!adoptedConfig}
          className="w-[44%] min-w-[340px] max-w-[760px] shrink-0"
        />
      </div>
    </div>
  );
}
