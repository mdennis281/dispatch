/**
 * Project settings → Agent context.
 *
 * The project half of what App settings → Agent context sets, plus the one
 * question only a repo can answer: whether its house rules sit ALONGSIDE the
 * machine-wide ones or stand IN FOR them.
 *
 * Self-contained (its own draft, its own save) like IssuesPane, rather than
 * riding the page's shared save bar: this block lands in `project.yaml` through
 * its own endpoint, and the house-rules FILES are not part of that block at all
 * — they're files with their own writes and their own cap errors. Folding them
 * into one save button would make "Save" mean three different things.
 *
 * Every numeric field here is an OVERRIDE: blank means inherit, and the
 * placeholder shows what is inherited rather than the shipped default, so
 * clearing a field tells you where the value will come from instead of leaving
 * you to guess.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Layers2, Replace } from "lucide-react";
import {
  DEFAULT_HOUSE_RULES_LIMIT,
  DEFAULT_MEMORY_CHAR_BUDGET,
  DEFAULT_MEMORY_FULL_LIMIT,
  DEFAULT_MEMORY_SURFACE_LIMIT,
  type AgentContextSettings,
  type HouseRules,
  type HouseRulesMode,
  type ProjectAgentContext,
} from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { Field, TextInput } from "../sidebar/Modal.js";
import { HouseRulesEditor } from "../settings/HouseRulesEditor.js";
import { cn } from "../../lib/cn.js";

function numberField(raw: string): number | undefined {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

const MODES: { id: HouseRulesMode; label: string; hint: string; icon: typeof Layers2 }[] = [
  {
    id: "append",
    label: "Alongside",
    hint: "The machine-wide rules first, then this repo's.",
    icon: Layers2,
  },
  {
    id: "replace",
    label: "Instead of",
    hint: "This repo's rules only. The global file is not sent at all.",
    icon: Replace,
  },
];

export function AgentContextPane({
  projectId,
  hasConfigDir,
  saved: savedBlock,
}: {
  projectId: string;
  hasConfigDir: boolean;
  /**
   * The project's `agentContext:` block as it stands in `project.yaml`, or null
   * when it authors none.
   *
   * Load-bearing, not a convenience. The save is a WHOLE-BLOCK replace, so a
   * draft that started empty would write an empty block over whatever was
   * there: open this pane on a project with `houseRulesLimit: 3000`, click the
   * mode toggle, press Save, and the 3000 is gone with nothing said. The draft
   * has to start as what is already on disk.
   */
  saved: ProjectAgentContext | null;
}) {
  const [rules, setRules] = useState<HouseRules | null>(null);
  // The app layer, so a blank override can name what it INHERITS rather than
  // the shipped default. Fetched rather than passed in: this pane is mounted
  // from a section registry that knows nothing about app settings, and a
  // placeholder that lies about where a value comes from is worse than a
  // placeholder that arrives a moment late.
  const [app, setApp] = useState<AgentContextSettings>({});
  // Both seeded from what is ON DISK, so `dirty` means "differs from the file"
  // and a save carries every override — including the ones no field on this
  // pane happens to render.
  const [draft, setDraft] = useState<ProjectAgentContext | null>(savedBlock);
  const [saved, setSaved] = useState<ProjectAgentContext | null>(savedBlock);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    // Best-effort: a failed settings read costs a placeholder its accuracy, not
    // the pane its function, so it must not set the error banner.
    api.settings
      .get()
      .then((s) => live && setApp(s.agentContext ?? {}))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The config arrives asynchronously on the page that mounts this, so the
  // first render can legitimately see null. Re-seed when it lands — but only
  // while the form is CLEAN, or a slow config load would discard edits that
  // started before it arrived.
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(savedBlock);
    setSaved(savedBlock);
  }, [savedBlock]);

  useEffect(() => {
    let live = true;
    setRules(null);
    // House rules are FILES, fetched separately from the manifest block. This
    // read feeds the editor and `replacing` ONLY — deliberately not the draft,
    // because `r.mode` is the RESOLVED mode: it says "append" whether the
    // project authored that or authored nothing, so writing it back would pin
    // a default the first time anybody pressed Save.
    api.houseRules
      .get(projectId)
      .then((r) => live && setRules(r))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Failed to load."));
    return () => {
      live = false;
    };
  }, [projectId]);
  const patch = (p: Partial<ProjectAgentContext>) => {
    setDraft((d) => ({ ...(d ?? {}), ...p }));
    setSavedAt(null);
  };
  const patchMemory = (p: Partial<NonNullable<ProjectAgentContext["memory"]>>) =>
    setDraft((d) => {
      setSavedAt(null);
      return { ...(d ?? {}), memory: { ...(d?.memory ?? {}), ...p } };
    });

  const save = async () => {
    if (!draft || saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      // `append` is the default, so writing it would put a line in project.yaml
      // that says what absence already says. Dropped here rather than in the
      // writer's prune, which can't know which value is the default.
      const block: ProjectAgentContext = {
        ...draft,
        ...(draft.houseRulesMode === "append" ? { houseRulesMode: undefined } : {}),
      };
      await api.houseRules.saveProjectContext(projectId, block);
      // `block`, not `draft` — what is on disk is what was sent, and the config
      // reload that follows hands the same thing back as `savedBlock`.
      setSaved(block);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const mode = draft?.houseRulesMode ?? "append";
  const replacing = mode === "replace" && Boolean(rules?.project?.text);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-primary">Agent context</h3>
        <p className="mt-1 text-xs leading-snug text-faint">
          What every chat in this repo is handed before it reads the task. Overrides your app
          settings; anything left blank inherits them.
        </p>
      </div>

      {!hasConfigDir && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-secondary">
          This project has no config dir, so the settings below have nowhere to be written.
          Create one and they'll land in its <code className="cm-mono !text-2xs">project.yaml</code>{" "}
          — committable, so everyone working in this repo gets them. The house-rules file itself
          saves either way.
        </p>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      {rules?.project ? (
        <HouseRulesEditor
          projectId={projectId}
          file={rules.project}
          hint={
            replacing
              ? "Every chat in this project — and INSTEAD of the machine-wide rules, which are not sent here."
              : "Every chat in this project, after the machine-wide rules."
          }
          onSaved={(f) => setRules((r) => (r ? { ...r, project: f } : r))}
        />
      ) : (
        <p className="text-xs text-faint">Loading…</p>
      )}

      <div className="space-y-2 border-t border-line-soft pt-3">
        <div className="text-xs font-medium text-secondary">Against the global rules</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => patch({ houseRulesMode: m.id })}
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
                  active
                    ? "border-accent bg-accent/10"
                    : "border-line bg-panel-2/40 hover:border-line-strong",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-primary [&_svg]:size-3.5">
                  <Icon className={active ? "text-accent" : "text-muted"} />
                  {m.label}
                </span>
                <span className="text-2xs leading-snug text-faint">{m.hint}</span>
              </button>
            );
          })}
        </div>
        {mode === "replace" && !rules?.project?.text && (
          // Otherwise "replace" with an empty file reads as "this project has no
          // house rules", which is not what suppressing the global file means.
          <p className="text-2xs leading-snug text-warn">
            Nothing to replace them with yet — while this project's file is empty the global
            rules are still sent.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-line-soft pt-3">
        <div className="text-xs font-medium text-secondary">Overrides</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="House-rules cap"
            hint={`blank = ${app.houseRulesLimit ?? DEFAULT_HOUSE_RULES_LIMIT}`}
          >
            <TextInput
              mono
              inputMode="numeric"
              value={draft?.houseRulesLimit != null ? String(draft.houseRulesLimit) : ""}
              onChange={(e) => patch({ houseRulesLimit: numberField(e.target.value) })}
              placeholder={String(app.houseRulesLimit ?? DEFAULT_HOUSE_RULES_LIMIT)}
            />
          </Field>
          <Field
            label="Memories per turn"
            hint={`blank = ${app.memory?.surfaceLimit ?? DEFAULT_MEMORY_SURFACE_LIMIT}`}
          >
            <TextInput
              mono
              inputMode="numeric"
              value={draft?.memory?.surfaceLimit != null ? String(draft.memory.surfaceLimit) : ""}
              onChange={(e) => patchMemory({ surfaceLimit: numberField(e.target.value) })}
              placeholder={String(app.memory?.surfaceLimit ?? DEFAULT_MEMORY_SURFACE_LIMIT)}
            />
          </Field>
          <Field
            label="Of those, in full"
            hint={`blank = ${app.memory?.fullLimit ?? DEFAULT_MEMORY_FULL_LIMIT}`}
          >
            <TextInput
              mono
              inputMode="numeric"
              value={draft?.memory?.fullLimit != null ? String(draft.memory.fullLimit) : ""}
              onChange={(e) => patchMemory({ fullLimit: numberField(e.target.value) })}
              placeholder={String(app.memory?.fullLimit ?? DEFAULT_MEMORY_FULL_LIMIT)}
            />
          </Field>
          <Field
            label="Char budget"
            hint={`blank = ${app.memory?.charBudget ?? DEFAULT_MEMORY_CHAR_BUDGET}`}
          >
            <TextInput
              mono
              inputMode="numeric"
              value={draft?.memory?.charBudget != null ? String(draft.memory.charBudget) : ""}
              onChange={(e) => patchMemory({ charBudget: numberField(e.target.value) })}
              placeholder={String(app.memory?.charBudget ?? DEFAULT_MEMORY_CHAR_BUDGET)}
            />
          </Field>
        </div>
        <p className="text-xs leading-snug text-faint">
          Raising the cap here raises it for this project's file only — the global file is still
          written against the app-level cap, because every other project reads it.
        </p>
      </div>

      <div className="flex items-center gap-2 border-t border-line-soft pt-3">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Check />}
          disabled={!dirty || saving || !hasConfigDir}
          onClick={() => void save()}
        >
          Save to project.yaml
        </Button>
        {savedAt && !dirty && <span className="text-2xs text-success">Saved.</span>}
      </div>
    </div>
  );
}
