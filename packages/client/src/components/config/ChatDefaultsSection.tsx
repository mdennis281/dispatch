/**
 * The project layer of what a chat runs as — `defaults.{harness,mode,effort,
 * model,showInjectedContext}` and `spawnChat.autoApprove` in `project.yaml`.
 *
 * Every field here is one `LayeredField`: the control shows the EFFECTIVE
 * value (this project's pin, else the app's answer), the line under it says
 * which, and "Inherit …" is the way back. The inherited values come from the
 * same `resolveChatPosture` / `resolveLayered` the server runs, fed the app
 * layer the settings store keeps — so what this pane says a new chat will get
 * is what `createChat` gives it.
 *
 * Manifest-backed only. These keys are read from the loaded config and never
 * mirrored into the stored project row (that is how the stable and dev
 * instances came to disagree about a project's harness), so a project without
 * a config dir has nowhere to keep them and the pane says so instead of
 * offering controls whose save would fail.
 */
import { Cpu, MessagesSquare } from "lucide-react";
import {
  listProviders,
  projectHarnessOf,
  resolveChatPosture,
  resolveLayered,
  type Effort,
  type HarnessKind,
  type LayerSource,
  type PostureSource,
} from "@dispatch/shared";
import { postureSourceShort } from "../../lib/chatPosture.js";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { harnessLabel } from "../../lib/harness.js";
import { useProviderCatalogs } from "../../lib/useProviderCatalogs.js";
import { useProjects } from "../../stores/projects.js";
import { useSettings } from "../../stores/settings.js";
import type { ChatDefaultsDraft } from "../../stores/settingsDraft.js";
import { modeLabel } from "../chat/ModeControl.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { Switch } from "../ui/Switch.js";
import { LayeredField } from "./LayeredField.js";

export function ChatDefaultsSection({
  value,
  onChange,
  hasDir,
  disabled,
}: {
  value: ChatDefaultsDraft;
  onChange: (next: ChatDefaultsDraft) => void;
  /** False when the project has no config dir — nothing here can be saved. */
  hasDir: boolean;
  disabled?: boolean;
}) {
  const app = useSettings((s) => s.app);
  const modes = useProjects((s) => s.modes);
  const { harnesses, catalogs } = useProviderCatalogs();
  const off = disabled || !hasDir;

  const patch = (p: Partial<ChatDefaultsDraft>) => {
    const next = { ...value, ...p };
    for (const key of Object.keys(next) as (keyof ChatDefaultsDraft)[]) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next);
  };

  // Resolve the DRAFT as the project layer, with no chat, so every field's
  // `source` is either "project" (pinned here) or the app/default beneath.
  const posture = resolveChatPosture({
    project: { harness: value.harness, mode: value.mode, effort: value.effort, model: value.model },
    settings: app,
  });
  // What each field would inherit if ITS pin were cleared. Effort and model read
  // the app's per-provider block, so the layer beneath them keeps the project's
  // provider pin — resolving with no project layer at all named the app-default
  // provider's levels: "Inheriting High" under a Select showing XHigh, on a
  // project pinned to codex. The provider field is the one exception: what it
  // inherits is the app layer alone.
  const beneath = resolveChatPosture({ project: { harness: value.harness }, settings: app });
  const beneathHarness = resolveChatPosture({ settings: app });
  const provider = projectHarnessOf({ harness: value.harness }, app);
  const injected = resolveLayered(
    { project: value.showInjectedContext, app: app.showInjectedContext },
    false,
  );
  const autoApprove = resolveLayered(
    { project: value.autoApprove, app: app.spawnChat?.autoApprove },
    false,
  );
  // `Layered.inherited` answers "if the CHAT's pin were cleared"; this pane IS
  // the project layer, so what its reset reveals is the app layer alone. (The
  // first cut used `inherited` here and offered "Inherit Automatic" on a
  // project that had just pinned Automatic.)
  const injectedBeneath = resolveLayered({ app: app.showInjectedContext }, false);
  const autoApproveBeneath = resolveLayered({ app: app.spawnChat?.autoApprove }, false);

  const harnessOptions: SelectOption<HarnessKind>[] = listProviders().map((p) => {
    const runtime = harnesses.find((h) => h.kind === p.id)?.runtime;
    return {
      value: p.id,
      label: p.label,
      hint: !harnesses.length ? undefined : runtime?.available ? (runtime.version ?? runtime.source) : "not installed",
    };
  });
  const efforts =
    harnesses.find((h) => h.kind === provider)?.capabilities.efforts ??
    listProviders().find((p) => p.id === provider)?.efforts ??
    [];
  const effortOptions = EFFORT_OPTIONS.filter((o) => efforts.includes(o.value));
  const effortLabelOf = (e: Effort) => EFFORT_OPTIONS.find((o) => o.value === e)?.label ?? e;
  const modeOptions: SelectOption<string>[] = modes.map((m) => ({
    value: m.id,
    label: m.name,
    hint: m.permissionMode,
  }));
  // A mode the list doesn't carry (a built-in posture like `auto`, or an id
  // from a hand-edited manifest) is still the answer — render it rather than a
  // blank chip that implies nothing is set.
  const modeId = posture.modeId.effective;
  if (!modeOptions.some((o) => o.value === modeId)) {
    modeOptions.unshift({ value: modeId, label: modeLabel(modes, modeId) });
  }
  const catalog = catalogs[provider] ?? [];
  const modelOptions: SelectOption<string>[] = [
    // The chip has to say SOMETHING when no model is pinned anywhere; picking
    // this row is the same as the inherit row, so it wears the same hint.
    { value: "", label: "Provider default", hint: "unpinned" },
    ...catalog.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
    ...(posture.model.effective && !catalog.some((m) => m.value === posture.model.effective)
      ? [{ value: posture.model.effective, label: posture.model.effective, hint: "not in catalog" }]
      : []),
  ];
  const modelLabelOf = (m: string | undefined) =>
    m ? (catalog.find((c) => c.value === m)?.label ?? m) : "Provider default";

  return (
    <div className="space-y-4">
      {!hasDir && (
        <div className="rounded-md border border-warn-line bg-warn-ghost px-3 py-2 text-2xs leading-snug text-secondary">
          These live in <span className="cm-mono">project.yaml</span>. Create a config dir for this
          project first; until then every chat here inherits your app settings.
        </div>
      )}

      <div className="rounded-md border border-line bg-panel-2/40 px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-secondary [&_svg]:size-3.5">
          <Cpu /> Runtime
        </div>
        <div className="space-y-3">
          <LayeredField
            label="Provider"
            description="Which agent runtime new chats in this repo start on. Existing chats keep theirs."
            pinned={value.harness !== undefined}
            source={layerOf(posture.harness.source)}
            inheritedLabel={harnessLabel(beneathHarness.harness.effective)}
            inheritedSource={layerOf(beneathHarness.harness.source)}
            onReset={() => patch({ harness: undefined, model: undefined })}
            disabled={off}
          >
            <Select
              width={220}
              align="end"
              value={posture.harness.effective}
              // A model pin belongs to the previous provider's catalogue, so it
              // goes with the provider — the same rule the reviewer pane and the
              // chat's own provider switch apply.
              onChange={(harness) => patch({ harness, model: undefined })}
              options={harnessOptions}
              inherit={{
                label: `Inherit · ${harnessLabel(beneathHarness.harness.effective)}`,
                hint: postureSourceShort(beneathHarness.harness.source),
                active: value.harness === undefined,
                onSelect: () => patch({ harness: undefined, model: undefined }),
              }}
            />
          </LayeredField>

          <LayeredField
            label="Model"
            description={`From ${harnessLabel(provider)}'s catalogue — the provider this project resolves to.`}
            pinned={value.model !== undefined}
            source={value.model !== undefined ? "project" : layerOf(beneath.model.source)}
            inheritedLabel={modelLabelOf(beneath.model.effective)}
            inheritedSource={layerOf(beneath.model.source)}
            onReset={() => patch({ model: undefined })}
            disabled={off}
          >
            <Select
              width={220}
              align="end"
              value={posture.model.effective ?? ""}
              onChange={(model) => patch({ model: model || undefined })}
              options={modelOptions}
              inherit={{
                label: `Inherit · ${modelLabelOf(beneath.model.effective)}`,
                hint: postureSourceShort(beneath.model.source, "provider"),
                active: value.model === undefined,
                onSelect: () => patch({ model: undefined }),
              }}
            />
          </LayeredField>

          <LayeredField
            label="Effort"
            description="Reasoning effort a new chat starts at. Any chat can still pick its own."
            pinned={value.effort !== undefined}
            source={layerOf(posture.effort.source)}
            inheritedLabel={effortLabelOf(beneath.effort.effective)}
            inheritedSource={layerOf(beneath.effort.source)}
            onReset={() => patch({ effort: undefined })}
            disabled={off}
          >
            <Select
              width={200}
              align="end"
              value={posture.effort.effective}
              onChange={(effort) => patch({ effort })}
              options={effortOptions.length ? effortOptions : EFFORT_OPTIONS}
              inherit={{
                label: `Inherit · ${effortLabelOf(beneath.effort.effective)}`,
                hint: postureSourceShort(beneath.effort.source),
                active: value.effort === undefined,
                onSelect: () => patch({ effort: undefined }),
              }}
            />
          </LayeredField>
        </div>
      </div>

      <div className="rounded-md border border-line bg-panel-2/40 px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-secondary [&_svg]:size-3.5">
          <MessagesSquare /> Posture
        </div>
        <div className="space-y-3">
          <LayeredField
            label="Mode"
            description="The mode and permission posture a new chat opens in."
            pinned={value.mode !== undefined}
            source={layerOf(posture.modeId.source)}
            inheritedLabel={modeLabel(modes, beneath.modeId.effective)}
            inheritedSource={layerOf(beneath.modeId.source)}
            onReset={() => patch({ mode: undefined })}
            disabled={off}
          >
            <Select
              width={220}
              align="end"
              value={modeId}
              onChange={(mode) => patch({ mode })}
              options={modeOptions}
              inherit={{
                label: `Inherit · ${modeLabel(modes, beneath.modeId.effective)}`,
                hint: postureSourceShort(beneath.modeId.source),
                active: value.mode === undefined,
                onSelect: () => patch({ mode: undefined }),
              }}
            />
          </LayeredField>

          <LayeredField
            label="Show sent context"
            description="Reveal what Dispatch attaches to turns on your behalf. Rendering only; the agent receives it either way."
            pinned={value.showInjectedContext !== undefined}
            source={injected.source}
            inheritedLabel={injectedBeneath.effective ? "Shown" : "Hidden"}
            inheritedSource={injectedBeneath.source}
            onReset={() => patch({ showInjectedContext: undefined })}
            disabled={off}
          >
            <Switch
              checked={injected.effective}
              onChange={(v) => patch({ showInjectedContext: v })}
              label={injected.effective ? "Shown" : "Hidden"}
              disabled={off}
            />
          </LayeredField>

          <LayeredField
            label="Auto-approve spawned chats"
            description="Whether an agent's spawn_chat starts unattended here. Off, every spawn waits on your approval."
            pinned={value.autoApprove !== undefined}
            source={autoApprove.source}
            inheritedLabel={autoApproveBeneath.effective ? "Automatic" : "Ask me"}
            inheritedSource={autoApproveBeneath.source}
            onReset={() => patch({ autoApprove: undefined })}
            disabled={off}
          >
            <Switch
              checked={autoApprove.effective}
              onChange={(v) => patch({ autoApprove: v })}
              label={autoApprove.effective ? "Automatic" : "Ask me"}
              disabled={off}
            />
          </LayeredField>
        </div>
      </div>
    </div>
  );
}

/**
 * A posture source as a three-layer one. This pane resolves with no chat and
 * no parent, so neither can occur; the narrowing is for the type, not a case.
 */
function layerOf(source: PostureSource): LayerSource {
  return source === "chat" || source === "parent" ? "project" : source;
}
