import { Cpu } from "lucide-react";
import { SHELL_TRANSCRIPT_CATEGORIES } from "@dispatch/shared";
import type { Effort, HarnessKind } from "@dispatch/shared";
import { Field } from "../../sidebar/Modal.js";
import { Select, type SelectOption } from "../../ui/Select.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Switch } from "../../ui/Switch.js";
import { ShellFilterPanel } from "../../chat/ShellFilterPanel.js";
import { EFFORT_OPTIONS } from "../../../lib/efforts.js";
import { useProjects } from "../../../stores/projects.js";
import type { AppPaneProps } from "./types.js";

/**
 * What a NEW chat starts as, and what every transcript shows.
 *
 * These were scattered down the old single-column modal under a heading called
 * "Defaults", which also housed the token limits — so "which model do I get" and
 * "when does the context get summarized" were neighbours purely by scroll
 * position. Anything that answers "what happens when I open a chat" is here;
 * anything about the window filling up is in Context.
 */
export function ChatSection({ draft, patch, harnesses, catalogs }: AppPaneProps) {
  const modes = useProjects((s) => s.modes);
  const harness = draft.harness ?? {};

  const patchHarnessDefault = (kind: HarnessKind, p: { model?: string; effort?: Effort }) =>
    patch({
      harness: {
        ...harness,
        defaults: { ...harness.defaults, [kind]: { ...harness.defaults?.[kind], ...p } },
      },
    });

  const modeOptions: SelectOption<string>[] = [
    { value: "", label: "None (SDK default)", hint: "no fixed mode" },
    ...modes.map((m) => ({ value: m.id, label: m.name, hint: m.permissionMode })),
  ];

  const harnessOptions: SelectOption<HarnessKind>[] = (["claude", "codex"] as const).map((kind) => {
    const runtime = harnesses.find((h) => h.kind === kind)?.runtime;
    return {
      value: kind,
      label: kind === "claude" ? "Claude Code" : "Codex",
      hint: runtime?.available ? runtime.version ?? runtime.source : "not installed",
    };
  });

  return (
    <div className="space-y-4">
      <div>
        <SectionLabel className="mb-1.5 px-0">Defaults</SectionLabel>
        <Field label="Default provider" hint="new projects and chats inherit this">
          <Select
            width={280}
            align="start"
            value={harness.defaultHarness ?? "claude"}
            onChange={(defaultHarness) => patch({ harness: { ...harness, defaultHarness } })}
            options={harnessOptions}
          />
        </Field>
        <Field label="Default mode" hint="new chats start here">
          <Select
            width={240}
            align="start"
            value={draft.defaultModeId ?? ""}
            onChange={(v) => patch({ defaultModeId: v || undefined })}
            options={modeOptions}
          />
        </Field>

        {/* One card per provider — the model and the effort are one decision,
            and they're a different decision for each. */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(["claude", "codex"] as const).map((kind) => {
            const defaults = harness.defaults?.[kind] ?? {};
            const efforts =
              harnesses.find((h) => h.kind === kind)?.capabilities.efforts ??
              EFFORT_OPTIONS.map((o) => o.value);
            const modelOptions: SelectOption<string>[] = [
              { value: "", label: "Provider default", hint: "unpinned" },
              ...(catalogs[kind] ?? []).map((m) => ({
                value: m.value,
                label: m.label,
                hint: m.hint,
              })),
            ];
            return (
              <div key={kind} className="rounded-md border border-line bg-inset/40 p-2.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium capitalize text-secondary [&_svg]:size-3.5">
                  <Cpu /> {kind}
                </div>
                <div className="space-y-2">
                  <Field label="Model">
                    <Select
                      width={210}
                      className="w-full"
                      value={defaults.model ?? ""}
                      onChange={(model) => patchHarnessDefault(kind, { model: model || undefined })}
                      options={modelOptions}
                    />
                  </Field>
                  <Field label="Effort">
                    <Select
                      width={180}
                      className="w-full"
                      value={defaults.effort ?? "medium"}
                      onChange={(effort) => patchHarnessDefault(kind, { effort })}
                      options={EFFORT_OPTIONS.filter((o) => efforts.includes(o.value))}
                    />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-line-soft pt-3">
        <SectionLabel className="mb-1.5 px-0">Transcript</SectionLabel>
        {/* The bottom of the chat → project → app → off chain. A project's
            `.dispatch/project.yaml` can override it for everyone working in that
            repo, and any single chat can override both. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">Show sent context</div>
            <p className="mt-0.5 text-2xs leading-snug text-faint">
              Reveal what Dispatch attaches to your turns on your behalf — surfaced memories,
              repo snapshots. Rendering only; the agent receives it either way.
            </p>
          </div>
          <Switch
            checked={!!draft.showInjectedContext}
            onChange={(v) => patch({ showInjectedContext: v })}
            label={draft.showInjectedContext ? "Shown" : "Hidden"}
          />
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-secondary">Transcript shell</div>
          <p className="mb-2 text-2xs leading-snug text-faint">
            App-wide visibility defaults. Projects and chats inherit these until they set their
            own filter.
          </p>
          <ShellFilterPanel
            value={draft.shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES]}
            inherited={[...SHELL_TRANSCRIPT_CATEGORIES]}
            onChange={(shellFilter) =>
              patch({ shellFilter: shellFilter ?? [...SHELL_TRANSCRIPT_CATEGORIES] })
            }
          />
        </div>
      </div>

      <div className="border-t border-line-soft pt-3">
        <SectionLabel className="mb-1.5 px-0">Spawned chats</SectionLabel>
        {/* The ONLY way past the spawn_chat consent prompt — the tool itself
            takes no bypass argument, so an agent can't turn this on for you.
            A project's `.dispatch/project.yaml` can override it per repo. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">Auto-approve spawned chats</div>
            <p className="mt-0.5 text-2xs leading-snug text-faint">
              Agents can start new chats with <span className="font-mono">spawn_chat</span>. Off,
              every spawn waits on your approval; on, they start unattended.
            </p>
          </div>
          <Switch
            checked={!!draft.spawnChat?.autoApprove}
            onChange={(v) => patch({ spawnChat: { autoApprove: v } })}
            label={draft.spawnChat?.autoApprove ? "Automatic" : "Ask me"}
          />
        </div>
      </div>
    </div>
  );
}
