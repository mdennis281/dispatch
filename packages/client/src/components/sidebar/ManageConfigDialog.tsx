/**
 * Agents & Modes manager — CRUD over the two config rosters via the REST API.
 * A two-pane dialog: roster list on the left, an editor on the right. Because the
 * agents/modes routes don't emit WS events, each mutation re-pulls both lists and
 * re-hydrates the projects store (preserving the active project).
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Blocks, Plus, Trash2 } from "lucide-react";
import type {
  AgentConfig,
  AgentConfigInput,
  Effort,
  ModeConfig,
  PermissionMode,
  ConfigScope,
} from "@dispatch/shared";
import { Modal, Field, TextInput, TextArea, InlineError } from "./Modal.js";
import { Button } from "../ui/Button.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { api } from "../../lib/api.js";
import { useProjects } from "../../stores/projects.js";
import { useOverlay } from "../../stores/view.js";

type Tab = "agents" | "modes";

const PERM_OPTIONS: SelectOption<PermissionMode>[] = [
  { value: "default", label: "Default (ask)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
  { value: "dontAsk", label: "Don't ask" },
  { value: "auto", label: "Auto" },
];

/** "" = inherit the chat's effort (the default), mirroring an empty Model box. */
const EFFORT_OPTIONS: SelectOption<Effort | "">[] = [
  { value: "", label: "Inherit", hint: "chat's effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

const SCOPE_OPTIONS: SelectOption<ConfigScope>[] = [
  { value: "global", label: "Global" },
  { value: "project", label: "Project" },
];

interface FormState {
  id: string | null;
  name: string;
  permissionMode: PermissionMode;
  instructions: string;
  allowedTools: string;
  disallowedTools: string;
  model: string;
  effort: Effort | "";
  scope: ConfigScope;
  projectId: string;
}

const blankForm = (): FormState => ({
  id: null,
  name: "",
  permissionMode: "default",
  instructions: "",
  allowedTools: "",
  disallowedTools: "",
  model: "",
  effort: "",
  scope: "global",
  projectId: "",
});

const fromAgent = (a: AgentConfig): FormState => ({
  id: a.id,
  name: a.name,
  permissionMode: a.permissionMode,
  instructions: a.instructions,
  allowedTools: (a.allowedTools ?? []).join(", "),
  disallowedTools: (a.disallowedTools ?? []).join(", "),
  model: a.model ?? "",
  effort: a.effort ?? "",
  scope: a.scope,
  projectId: a.projectId ?? "",
});

const fromMode = (m: ModeConfig): FormState => ({
  ...blankForm(),
  id: m.id,
  name: m.name,
  permissionMode: m.permissionMode,
  instructions: m.instructions ?? "",
  scope: m.scope,
  projectId: m.projectId ?? "",
});

function toolList(s: string): string[] | undefined {
  const arr = s
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
}

/** Re-pull agents + modes and re-hydrate, keeping the active project focused. */
async function refreshConfig(): Promise<void> {
  const [agents, modes] = await Promise.all([api.agents.list(), api.modes.list()]);
  const st = useProjects.getState();
  const active = st.activeProjectId;
  st.hydrate({ projects: st.projects, agents, modes });
  if (active) st.setActiveProject(active);
}

export function ManageConfigDialog() {
  const { open, close: onClose } = useOverlay("agents");
  const agents = useProjects((s) => s.agents);
  const modes = useProjects((s) => s.modes);
  const projects = useProjects((s) => s.projects);

  const [tab, setTab] = useState<Tab>("agents");
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(null);
      setError(null);
      setTab("agents");
    }
  }, [open]);

  // Switching roster clears the editor.
  function switchTab(t: Tab) {
    setTab(t);
    setForm(null);
    setError(null);
  }

  const patch = (p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f));

  const projectOptions: SelectOption<string>[] = projects.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const rows = tab === "agents" ? agents : modes;

  const valid = useMemo(() => {
    if (!form) return false;
    if (!form.name.trim()) return false;
    if (tab === "agents" && !form.instructions.trim()) return false;
    if (form.scope === "project" && !form.projectId) return false;
    return true;
  }, [form, tab]);

  async function save() {
    if (!form || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents") {
        const body: Partial<AgentConfigInput> = {
          name: form.name.trim(),
          permissionMode: form.permissionMode,
          instructions: form.instructions.trim(),
          scope: form.scope,
          allowedTools: toolList(form.allowedTools),
          disallowedTools: toolList(form.disallowedTools),
          model: form.model.trim() || undefined,
          // `null`, not undefined: JSON drops undefined keys, and the PUT merges
          // over the stored record — so only an explicit null clears a pin.
          effort: form.effort || null,
          projectId: form.scope === "project" ? form.projectId : undefined,
        };
        const saved = form.id
          ? await api.agents.update(form.id, body)
          : await api.agents.create(body);
        await refreshConfig();
        setForm(fromAgent(saved));
      } else {
        const body: Partial<ModeConfig> = {
          name: form.name.trim(),
          permissionMode: form.permissionMode,
          instructions: form.instructions.trim() || undefined,
          scope: form.scope,
          projectId: form.scope === "project" ? form.projectId : undefined,
        };
        const saved = form.id
          ? await api.modes.update(form.id, body)
          : await api.modes.create(body);
        await refreshConfig();
        setForm(fromMode(saved));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!form?.id || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents") await api.agents.remove(form.id);
      else await api.modes.remove(form.id);
      await refreshConfig();
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      icon={<Bot />}
      title="Agents & modes"
      description="Custom instructions + permission profiles."
    >
      <div className="space-y-3">
        <SegmentedControl<Tab>
          size="md"
          value={tab}
          onChange={switchTab}
          segments={[
            { value: "agents", label: "Agents", icon: <Bot /> },
            { value: "modes", label: "Modes", icon: <Blocks /> },
          ]}
        />

        <div className="flex h-[420px] overflow-hidden rounded-md border border-line">
          {/* roster */}
          <div className="flex w-[220px] shrink-0 flex-col border-r border-line bg-inset/50">
            <div className="cm-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
              {rows.length === 0 && (
                <p className="px-2 py-3 text-[11.5px] text-faint">
                  No {tab} yet. Create one →
                </p>
              )}
              {rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setError(null);
                    setForm(tab === "agents" ? fromAgent(r as AgentConfig) : fromMode(r as ModeConfig));
                  }}
                  className={cn(
                    "mb-0.5 flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors",
                    form?.id === r.id ? "bg-accent-ghost/70" : "hover:bg-hover",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate text-[12px] font-medium",
                        form?.id === r.id ? "text-primary" : "text-secondary",
                      )}
                    >
                      {r.name}
                    </span>
                    {r.scope === "project" && (
                      <Chip tone="muted" className="ml-auto">
                        project
                      </Chip>
                    )}
                  </span>
                  <Chip tone="neutral" mono className="self-start">
                    {r.permissionMode}
                  </Chip>
                </button>
              ))}
            </div>
            <div className="border-t border-line p-1.5">
              <button
                onClick={() => {
                  setError(null);
                  setForm(blankForm());
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-panel-2 py-1.5 text-[11.5px] font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary [&_svg]:size-3.5"
              >
                <Plus />
                New {tab === "agents" ? "agent" : "mode"}
              </button>
            </div>
          </div>

          {/* editor */}
          <div className="min-w-0 flex-1">
            {!form ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <span className="mb-2 flex size-9 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-4">
                  {tab === "agents" ? <Bot /> : <Blocks />}
                </span>
                <p className="text-[12px] text-secondary">
                  Select {tab === "agents" ? "an agent" : "a mode"} to edit
                </p>
                <p className="mt-0.5 text-[11px] text-faint">or create a new one.</p>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="cm-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
                  <Field label="Name" required>
                    <TextInput
                      value={form.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder={tab === "agents" ? "Builder" : "Plan"}
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Permission mode">
                      <Select
                        options={PERM_OPTIONS}
                        value={form.permissionMode}
                        onChange={(v) => patch({ permissionMode: v })}
                        width={280}
                        className="w-full"
                      />
                    </Field>
                    <Field label="Scope">
                      <Select
                        options={SCOPE_OPTIONS}
                        value={form.scope}
                        onChange={(v) => patch({ scope: v })}
                        width={280}
                        className="w-full"
                      />
                    </Field>
                  </div>

                  {form.scope === "project" && (
                    <Field label="Project" required hint="scoped to">
                      <Select
                        options={
                          projectOptions.length
                            ? projectOptions
                            : [{ value: "", label: "No projects" }]
                        }
                        value={form.projectId}
                        onChange={(v) => patch({ projectId: v })}
                        width={560}
                        className="w-full"
                      />
                    </Field>
                  )}

                  <Field
                    label="Instructions"
                    required={tab === "agents"}
                    hint={tab === "modes" ? "optional overlay" : undefined}
                  >
                    <TextArea
                      rows={5}
                      value={form.instructions}
                      onChange={(e) => patch({ instructions: e.target.value })}
                      placeholder={
                        tab === "agents"
                          ? "Principal engineer. Small, tested, conventional commits."
                          : "Optional system-prompt overlay for this mode."
                      }
                    />
                  </Field>

                  {tab === "agents" && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Allowed tools" hint="comma-sep">
                          <TextInput
                            mono
                            value={form.allowedTools}
                            onChange={(e) => patch({ allowedTools: e.target.value })}
                            placeholder="Read, Grep, Bash"
                          />
                        </Field>
                        <Field label="Disallowed tools" hint="comma-sep">
                          <TextInput
                            mono
                            value={form.disallowedTools}
                            onChange={(e) => patch({ disallowedTools: e.target.value })}
                            placeholder="WebFetch"
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Model" hint="optional override">
                          <TextInput
                            mono
                            value={form.model}
                            onChange={(e) => patch({ model: e.target.value })}
                            placeholder="claude-opus-4-8"
                          />
                        </Field>
                        {/* Pins the level for this agent whether it runs as the
                            main thread or is spawned as a subagent; "Inherit"
                            (the default) follows the chat's picker. */}
                        <Field label="Effort" hint="optional override">
                          <Select
                            options={EFFORT_OPTIONS}
                            value={form.effort}
                            onChange={(effort) => patch({ effort })}
                            width={200}
                          />
                        </Field>
                      </div>
                    </>
                  )}

                  <InlineError message={error} />
                </div>

                <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
                  {form.id && (
                    <Button
                      variant="danger"
                      leftIcon={<Trash2 />}
                      onClick={remove}
                      disabled={busy}
                    >
                      Delete
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    className="ml-auto"
                    onClick={save}
                    disabled={!valid || busy}
                  >
                    {busy ? "Saving…" : form.id ? "Save changes" : `Create ${tab === "agents" ? "agent" : "mode"}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
