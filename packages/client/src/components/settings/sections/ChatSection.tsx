import { useMemo } from "react";
import { Cpu } from "lucide-react";
import {
  AGENT_TASKS,
  DEFAULT_HARNESS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_ROUNDS,
  DEFAULT_MODE_ID,
  SHELL_TRANSCRIPT_CATEGORIES,
  accountLabel,
  listProviders,
  reviewRoundCap,
} from "@dispatch/shared";
import type {
  Effort,
  HarnessDefaults,
  HarnessKind,
  ProjectConfigLocation,
  ReviewRoundsMode,
  ReviewRoundsPolicy,
} from "@dispatch/shared";
import { Field } from "../../sidebar/Modal.js";
import { Select, type SelectOption } from "../../ui/Select.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Switch } from "../../ui/Switch.js";
import { ShellFilterPanel } from "../../chat/ShellFilterPanel.js";
import { modeLabel } from "../../chat/ModeControl.js";
import { EFFORT_OPTIONS } from "../../../lib/efforts.js";
import { useProjects } from "../../../stores/projects.js";
import { useSubscriptions } from "../../../stores/subscriptions.js";
import { useView } from "../../../stores/view.js";
import { Button } from "../../ui/Button.js";
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
const configLocationOptions: SelectOption<ProjectConfigLocation>[] = [
  {
    value: "external",
    label: "Outside the repo",
    hint: "nothing to commit",
  },
  {
    value: "repo",
    label: "In the repo (.dispatch/)",
    hint: "committed, shared with the team",
  },
];

export function ChatSection({ draft, patch, harnesses, catalogs }: AppPaneProps) {
  const modes = useProjects((s) => s.modes);
  const accounts = useSubscriptions((s) => s.list);
  const harness = draft.harness ?? {};
  // Every project that pins its own transcript filter — i.e. every project for
  // which the panel below is NOT the answer.
  //
  // The filter is a `useMemo`, NOT part of the selector: a selector that builds
  // an array returns a new identity on every store read, which zustand reads as
  // "changed" and re-renders into — "Maximum update depth exceeded", the whole
  // settings panel replaced by the error boundary.
  const projects = useProjects((s) => s.projects);
  const overriding = useMemo(
    () => projects.filter((p) => p.shellFilter !== undefined),
    [projects],
  );
  const openProjectFilter = (projectId: string) => {
    // The project-settings view reads the ACTIVE project, so getting there is a
    // project switch, not just a route change.
    useProjects.getState().setActiveProject(projectId);
    useView.getState().setProjectSection("chat");
    useView.getState().setView("project-settings");
  };

  // The install's reviewer defaults — the layer UNDER every project's own
  // `workflow.pr.reviewAgent`. Only the round policy lives here: the reviewer
  // model and effort are per provider (in the cards below, because a model id
  // belongs to one catalogue), and the account and its token are a secret that
  // never goes near a settings PUT.
  const reviewAgent = draft.reviewAgent ?? {};
  const appRounds = { ...DEFAULT_REVIEW_ROUNDS, ...reviewAgent.rounds };
  const patchRounds = (p: Partial<ReviewRoundsPolicy>) =>
    patch({ reviewAgent: { ...reviewAgent, rounds: { ...reviewAgent.rounds, ...p } } });

  const patchHarnessDefault = (kind: HarnessKind, p: HarnessDefaults) =>
    patch({
      harness: {
        ...harness,
        defaults: { ...harness.defaults, [kind]: { ...harness.defaults?.[kind], ...p } },
      },
    });

  // The floor of the mode chain is `auto` (see DEFAULT_MODE_ID) — what every
  // new-chat button used to pin by hand — so "unset" here means Auto, not the
  // SDK's own "ask about everything".
  const modeOptions: SelectOption<string>[] = [
    { value: "", label: `Built-in (${modeLabel(modes, DEFAULT_MODE_ID)})`, hint: "unpinned" },
    ...modes.map((m) => ({ value: m.id, label: m.name, hint: m.permissionMode })),
  ];

  const harnessOptions: SelectOption<HarnessKind>[] = listProviders().map((provider) => {
    const runtime = harnesses.find((h) => h.kind === provider.id)?.runtime;
    return {
      value: provider.id,
      label: provider.label,
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
            value={harness.defaultHarness ?? DEFAULT_HARNESS}
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
        {/* Only ever consulted when a config dir is PLACED for the first time —
            a project that already has one keeps it whatever this says, which is
            what makes the setting safe to flip on a live install. */}
        <Field label="New project config" hint="where a new project's config dir goes">
          <Select
            width={280}
            align="start"
            value={draft.projectConfigLocation ?? "external"}
            onChange={(projectConfigLocation) => patch({ projectConfigLocation })}
            options={configLocationOptions}
          />
        </Field>

        {/* One card per provider — the model and the effort are one decision,
            and they're a different decision for each. */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {listProviders().map(({ id: kind, label, efforts: seedEfforts }) => {
            const defaults = harness.defaults?.[kind] ?? {};
            const efforts =
              harnesses.find((h) => h.kind === kind)?.capabilities.efforts ?? seedEfforts;
            const effortOptions = EFFORT_OPTIONS.filter((o) => efforts.includes(o.value));
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
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-secondary [&_svg]:size-3.5">
                  <Cpu /> {label}
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
                      options={effortOptions}
                    />
                  </Field>
                  {/* Per provider, beside the chat defaults, because a reviewer
                      model is a model id and belongs to one catalogue. A
                      project's own reviewer block still wins over both. */}
                  {/* Only once the provider HAS a choice of account — the implicit
                      one alone is not a decision anyone needs to see. */}
                  {accounts.filter((a) => a.provider === kind).length > 1 && (
                    <Field label="Account" hint="new chats start on it">
                      <Select
                        width={210}
                        className="w-full"
                        value={
                          defaults.subscriptionId ??
                          accounts.find((a) => a.provider === kind && a.isDefault)?.id ??
                          ""
                        }
                        onChange={(subscriptionId) =>
                          patchHarnessDefault(kind, { subscriptionId: subscriptionId || undefined })
                        }
                        options={accounts
                          .filter((a) => a.provider === kind)
                          .map((a) => ({
                            value: a.id,
                            label: accountLabel(a),
                            hint: a.loggedIn ? undefined : "not logged in",
                          }))}
                      />
                    </Field>
                  )}
                  <Field label="Reviewer model" hint="when the project doesn't pin one">
                    <Select
                      width={210}
                      className="w-full"
                      value={defaults.reviewer?.model ?? ""}
                      onChange={(model) =>
                        patchHarnessDefault(kind, {
                          reviewer: { ...defaults.reviewer, model: model || undefined },
                        })
                      }
                      options={modelOptions}
                    />
                  </Field>
                  <Field label="Reviewer effort">
                    <Select<Effort | "">
                      width={180}
                      className="w-full"
                      value={defaults.reviewer?.effort ?? ""}
                      onChange={(effort) =>
                        patchHarnessDefault(kind, {
                          reviewer: { ...defaults.reviewer, effort: effort || undefined },
                        })
                      }
                      options={[
                        {
                          value: "",
                          label: "Task default",
                          hint: AGENT_TASKS["pr:review"].defaultEffort,
                        },
                        ...effortOptions,
                      ]}
                    />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-line-soft pt-3">
        <SectionLabel className="mb-1.5 px-0">Review rounds</SectionLabel>
        <p className="mb-2 text-2xs leading-snug text-faint">
          How many times Dispatch&rsquo;s own reviewer may go round on one pull request
          before it stops. A project&rsquo;s Reviewer pane overrides any of this; what it
          leaves alone lands here. The cap is what stops a PR that never converges &mdash;
          and scaling it to the diff is the answer to a fixed number having to serve both a
          typo fix and a 4,000-line refactor.
        </p>
        <Field label="Sizing" hint="how the per-PR cap is decided">
          <Select<ReviewRoundsMode>
            width={220}
            align="start"
            value={appRounds.mode}
            onChange={(mode) => patchRounds({ mode })}
            options={[
              { value: "static", label: "Fixed cap", hint: "every PR the same" },
              { value: "dynamic", label: "Scale to the diff", hint: "bigger PR, more rounds" },
            ]}
          />
        </Field>
        {appRounds.mode === "static" ? (
          <Field label="Cap" hint="rounds per pull request">
            <Select
              width={220}
              align="start"
              value={String(reviewAgent.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS)}
              onChange={(v) => patch({ reviewAgent: { ...reviewAgent, maxRounds: Number(v) } })}
              options={[1, 2, 3, 4, 6, 8, 12].map((n) => ({
                value: String(n),
                label: n === 1 ? "1 round · no re-review" : `${n} rounds`,
              }))}
            />
          </Field>
        ) : (
          <>
            <Field label="Start at" hint="what the smallest diff gets">
              <Select
                width={220}
                align="start"
                value={String(appRounds.base)}
                onChange={(v) => patchRounds({ base: Number(v) })}
                options={[1, 2, 3, 4].map((n) => ({
                  value: String(n),
                  label: n === 1 ? "1 round" : `${n} rounds`,
                }))}
              />
            </Field>
            <Field label="+1 round per" hint="lines added plus deleted">
              <Select
                width={220}
                align="start"
                value={String(appRounds.linesPerRound)}
                onChange={(v) => patchRounds({ linesPerRound: Number(v) })}
                options={[100, 200, 250, 500, 750, 1000, 1500, 2000].map((n) => ({
                  value: String(n),
                  label: `${n} lines`,
                }))}
              />
            </Field>
            <Field label="Ceiling" hint="no diff buys more than this">
              <Select
                width={220}
                align="start"
                value={String(appRounds.max)}
                onChange={(v) => patchRounds({ max: Number(v) })}
                options={[2, 3, 4, 6, 8, 12, 20].map((n) => ({
                  value: String(n),
                  label: `${n} rounds`,
                }))}
              />
            </Field>
            {/* The law, run on four diff sizes: a formula in prose is a thing
                people get wrong by one round, worked numbers are not. */}
            <p className="mt-1 text-2xs leading-snug text-faint">
              {[50, 600, 1500, 5000]
                .map(
                  (n) =>
                    `${n.toLocaleString()} lines → ` +
                    `${reviewRoundCap({ maxRounds: reviewAgent.maxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS, rounds: appRounds }, n)}`,
                )
                .join(" · ")}
            </p>
          </>
        )}
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
          <div className="mb-1 text-xs font-medium text-secondary">Transcript visibility</div>
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
          {/* The panel above is the BOTTOM of the chain, and a project pin is
              invisible from here — so a category switched back on could save
              correctly and change nothing in the chats the user was looking at,
              with no surface anywhere admitting why. Naming the projects that
              outrank this is the whole fix; the link is just the shortcut. */}
          {overriding.length > 0 && (
            <div className="mt-2 rounded-md border border-warn-line bg-warn-ghost px-2.5 py-2">
              <p className="text-2xs leading-snug text-secondary">
                {overriding.length === 1
                  ? "One project pins its own filter and ignores these defaults:"
                  : `${overriding.length} projects pin their own filter and ignore these defaults:`}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {overriding.map((p) => (
                  <Button
                    key={p.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => openProjectFilter(p.id)}
                  >
                    {p.name}
                    <span className="ml-1 text-faint">
                      {p.shellFilter!.length}/{SHELL_TRANSCRIPT_CATEGORIES.length}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
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

      <div className="border-t border-line-soft pt-3">
        <SectionLabel className="mb-1.5 px-0">Worktrees</SectionLabel>
        {/* On by default, unlike the spawn toggle above — see the schema comment
            on `worktreeCleanup`. Removal is gated on merged + clean + pushed +
            nothing running in it; this switch is for turning the whole thing
            off, not for making it safer. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">Clean up merged worktrees</div>
            <p className="mt-0.5 text-2xs leading-snug text-faint">
              Removes a worktree once its branch has merged, the tree is clean, everything is
              pushed and nothing is running in it — when the owning chat goes idle, and hourly
              for the ones whose chat never came back. <span className="font-mono">git
              worktree lock</span> keeps any tree permanently.
            </p>
          </div>
          <Switch
            checked={draft.worktreeCleanup?.enabled !== false}
            onChange={(v) =>
              patch({
                worktreeCleanup: {
                  enabled: v,
                  deleteBranch: draft.worktreeCleanup?.deleteBranch ?? true,
                },
              })
            }
            label={draft.worktreeCleanup?.enabled !== false ? "Automatic" : "Off"}
          />
        </div>
        {draft.worktreeCleanup?.enabled !== false && (
          <div className="mt-2.5 flex items-start justify-between gap-3 pl-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-secondary">Delete the branch too</div>
              <p className="mt-0.5 text-2xs leading-snug text-faint">
                <span className="font-mono">git worktree remove</span> leaves the local branch
                behind, so without this a drained backlog leaves one dead ref per tree.
              </p>
            </div>
            <Switch
              checked={draft.worktreeCleanup?.deleteBranch !== false}
              onChange={(v) =>
                patch({
                  worktreeCleanup: {
                    enabled: draft.worktreeCleanup?.enabled ?? true,
                    deleteBranch: v,
                  },
                })
              }
              label={draft.worktreeCleanup?.deleteBranch !== false ? "Yes" : "Keep"}
            />
          </div>
        )}
      </div>

      <div className="border-t border-line-soft pt-3">
        <SectionLabel className="mb-1.5 px-0">Issues</SectionLabel>
        {/* The master switch only. Enrolment is per project (Project config →
            Issues), so this is never what turns the feature ON — it is the one
            place that turns every project OFF at once. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-secondary">Start chats from new issues</div>
            <p className="mt-0.5 text-2xs leading-snug text-faint">
              Polls the tracker of every project that opted in (Project config → Issues) and
              starts a chat for each batch of newly opened issues. Off here stops all of them,
              whatever the projects say.
            </p>
          </div>
          <Switch
            checked={draft.issueWatcher?.enabled !== false}
            onChange={(v) => patch({ issueWatcher: { enabled: v } })}
            label={draft.issueWatcher?.enabled !== false ? "On" : "Off"}
          />
        </div>
      </div>
    </div>
  );
}
