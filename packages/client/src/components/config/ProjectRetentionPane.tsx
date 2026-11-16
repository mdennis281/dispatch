/**
 * Project settings → Retention: this repo's `retention:` block.
 *
 * The three numbers a manifest may override (see `ProjectRetentionSchema` for
 * why the deletion windows are not among them): how many chats load, and this
 * project's share of each browser's artifact cache and preload budget.
 *
 * Self-contained like AgentContextPane — its own draft, its own save — because
 * the block lands in `project.yaml` through its own endpoint. Seeded from what
 * is on disk, since the save is a whole-block replace and a draft that started
 * empty would drop every override it did not render.
 *
 * Every field is an OVERRIDE: blank inherits, and the placeholder names the
 * value inherited from the app rather than the shipped default.
 */
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import {
  ARTIFACT_CACHE_MB_CEILING,
  ARTIFACT_PRELOAD_MB_CEILING,
  MAX_CHATS_PER_PROJECT_CEILING,
  resolveRetention,
  type ProjectRetention,
} from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { enforceArtifactCacheLimits } from "../../lib/artifactCache.js";
import { numberField } from "../../lib/format.js";
import { useSettings } from "../../stores/settings.js";
import { Button } from "../ui/Button.js";
import { Field, TextInput } from "../sidebar/Modal.js";

export function ProjectRetentionPane({
  projectId,
  hasConfigDir,
  saved: savedBlock,
}: {
  projectId: string;
  hasConfigDir: boolean;
  /** The `retention:` block as it stands in `project.yaml`, or null. */
  saved: ProjectRetention | null;
}) {
  const app = resolveRetention(useSettings((s) => s.app.retention));
  const [draft, setDraft] = useState<ProjectRetention>(savedBlock ?? {});
  const [saved, setSaved] = useState<ProjectRetention>(savedBlock ?? {});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed when the config lands or reloads — only while clean, so a slow
  // load cannot discard edits made before it arrived.
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(savedBlock ?? {});
    setSaved(savedBlock ?? {});
  }, [savedBlock]);

  const set = (p: Partial<ProjectRetention>) => {
    setSavedAt(null);
    setDraft((d) => ({ ...d, ...p }));
  };

  const over = (v: number | undefined, max: number) => v != null && v > max;
  const invalid =
    over(draft.maxChatsPerProject, MAX_CHATS_PER_PROJECT_CEILING) ||
    over(draft.artifactCacheMb, ARTIFACT_CACHE_MB_CEILING) ||
    over(draft.artifactPreloadMb, ARTIFACT_PRELOAD_MB_CEILING);

  const save = async () => {
    if (saving || !dirty || invalid) return;
    setSaving(true);
    setError(null);
    try {
      await api.projectConfig.saveRetention(projectId, draft);
      setSaved(draft);
      setSavedAt(Date.now());
      // A narrowed share applies now rather than at this project's next write.
      void enforceArtifactCacheLimits();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const appCache = app.artifactCacheMb.effective;
  const cacheAboveApp = draft.artifactCacheMb != null && appCache > 0 && draft.artifactCacheMb > appCache;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-primary">Retention</h3>
        <p className="mt-1 text-xs leading-snug text-faint">
          How much of this repo loads, and how much of each browser&apos;s artifact cache it may
          take. Overrides your app settings; anything left blank inherits them. Nothing here deletes
          anything on the server — how long chats and artifacts are KEPT is a machine-wide setting.
        </p>
      </div>

      {!hasConfigDir && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-secondary">
          This project has no config dir, so these overrides have nowhere to be written. Create one
          and they&apos;ll land in its <code className="cm-mono !text-2xs">project.yaml</code>.
        </p>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="space-y-2 border-b border-line-soft pb-3">
        <Field
          label="Chats loaded"
          hint={`blank = ${app.maxChatsPerProject.effective || "all"} from the app, 0 = all`}
          className="max-w-[16rem]"
        >
          <TextInput
            inputMode="numeric"
            aria-label="Chats loaded for this project"
            placeholder={String(app.maxChatsPerProject.effective)}
            value={draft.maxChatsPerProject == null ? "" : String(draft.maxChatsPerProject)}
            onChange={(e) => set({ maxChatsPerProject: numberField(e.target.value) })}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          The newest chats by last activity. The rest stay on disk and load when you ask.
        </p>
      </div>

      <div className="space-y-2 border-b border-line-soft pb-3">
        <div className="flex flex-wrap gap-3">
          <Field
            label="Artifact cache share"
            hint={`MB per device — blank = ${appCache} from the app, 0 = off`}
            className="max-w-[16rem]"
          >
            <TextInput
              inputMode="numeric"
              aria-label="Artifact cache share for this project (MB)"
              placeholder={String(appCache)}
              value={draft.artifactCacheMb == null ? "" : String(draft.artifactCacheMb)}
              onChange={(e) => set({ artifactCacheMb: numberField(e.target.value) })}
            />
          </Field>
          <Field
            label="Preload assets up to"
            hint={`MB per artifact — blank = ${app.artifactPreloadMb.effective} from the app, 0 = page only`}
            className="max-w-[16rem]"
          >
            <TextInput
              inputMode="numeric"
              aria-label="Artifact preload limit for this project (MB)"
              placeholder={String(app.artifactPreloadMb.effective)}
              value={draft.artifactPreloadMb == null ? "" : String(draft.artifactPreloadMb)}
              onChange={(e) => set({ artifactPreloadMb: numberField(e.target.value) })}
            />
          </Field>
        </div>
        {invalid && (
          <p className="text-xs text-danger">
            Limits: {MAX_CHATS_PER_PROJECT_CEILING.toLocaleString()} chats,{" "}
            {ARTIFACT_CACHE_MB_CEILING.toLocaleString()} MB cache, {ARTIFACT_PRELOAD_MB_CEILING} MB
            preload.
          </p>
        )}
        {cacheAboveApp && (
          <p className="text-xs text-warn">
            Above the app&apos;s {appCache} MB total — the total still applies, so this project can
            never hold more than that.
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted">
          A share can only narrow what this project keeps in each browser: the app&apos;s total is
          always enforced too. Useful for a repo whose agents ship large builds you don&apos;t want
          filling a phone. See what each browser holds under Settings → Browser storage.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Check />}
          disabled={!dirty || saving || invalid || !hasConfigDir}
          onClick={() => void save()}
        >
          Save to project.yaml
        </Button>
        {savedAt && !dirty && <span className="text-2xs text-success">Saved.</span>}
      </div>
    </div>
  );
}
