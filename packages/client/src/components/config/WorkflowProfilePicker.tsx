/**
 * WorkflowProfilePicker — choose how change ships in a project.
 *
 * The profile decides what the agent is TOLD to do (the injected workflow
 * contract), what it's stopped from doing (the trunk guard), whether memory
 * writes get committed, and whether the primary checkout follows the trunk after
 * a merge. So it's worth showing all of that, not just a three-way radio: the
 * consequences are the point, and picking "review" for a project with no CI is a
 * mistake you want to see before you make it.
 *
 * CONTROLLED: it renders the caller's draft and reports edits upward — it never
 * writes to the server itself. The owning view batches the draft behind one Save,
 * which is also what lets that save be routed to `project.yaml` when the repo has
 * one (the manifest overrides the stored record on every config reload, so a
 * per-click write to `.data` would quietly revert).
 */
import {
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  type LucideIcon,
} from "lucide-react";
import {
  resolveWorkflow,
  type WorkflowConfig,
  type WorkflowMergeMethod,
  type WorkflowProfile,
} from "@dispatch/shared";
import { Chip } from "../ui/Chip.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { cn } from "../../lib/cn.js";

interface ProfileOption {
  id: WorkflowProfile;
  icon: LucideIcon;
  label: string;
  blurb: string;
  /** The consequences, shown on the selected card. */
  effects: string[];
}

const OPTIONS: ProfileOption[] = [
  {
    id: "none",
    icon: GitBranch,
    label: "None",
    blurb: "Edit in the checkout. No branches, no PRs, no commit obligation.",
    effects: [
      "Agent works in the primary checkout",
      "Told NOT to branch, open PRs, or self-commit",
      "Memory left dirty for you to commit",
    ],
  },
  {
    id: "commit",
    icon: GitCommitHorizontal,
    label: "Commit",
    blurb: "Still the checkout, but work has to land as commits.",
    effects: [
      "Atomic conventional commits before a task is done",
      "Still no branches or PRs",
      "Memory committed automatically",
    ],
  },
  {
    id: "review",
    icon: GitPullRequest,
    label: "Review",
    blurb: "One task → one worktree → one reviewed PR.",
    effects: [
      "Work isolated in a worktree, shipped as a PR",
      "Commits/pushes to the trunk are refused",
      "Memory committed; trunk fast-forwarded after each merge",
    ],
  },
];

const MERGE_METHODS: { value: WorkflowMergeMethod; label: string }[] = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge" },
  { value: "rebase", label: "Rebase" },
];

/**
 * The switch's LOOK, with none of its behaviour — deliberately not `ui/Switch`.
 * Every one of these sits inside a row that is itself the clickable control, so
 * the real switch would be a nested interactive element: invalid markup, and two
 * overlapping hit targets for one decision. This is a plain span that shows the
 * state its row toggles.
 */
function Switch({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-accent-line bg-accent-dim/80" : "border-line bg-inset",
        disabled && "opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute size-3 rounded-full bg-primary shadow transition-transform",
          checked ? "translate-x-[14px]" : "translate-x-[3px]",
        )}
      />
    </span>
  );
}

export function WorkflowProfilePicker({
  value,
  onChange,
  fromManifest,
  inRepo,
  disabled,
}: {
  /** The caller's draft workflow block (never the persisted record). */
  value: WorkflowConfig;
  /** Report an edit; the caller decides when it reaches the server. */
  onChange: (next: WorkflowConfig) => void;
  /** True when a `project.yaml` backs this project, wherever it lives. */
  fromManifest: boolean;
  /**
   * Whether that manifest is INSIDE the working tree. Wording only — but a
   * footnote promising a save is "committable" when the file lives in the
   * install's own config dir is a promise the repo will not keep.
   */
  inRepo?: boolean;
  disabled?: boolean;
}) {
  // Resolve the DRAFT (not the project) so the card reflects unsaved edits, and
  // so a field the draft leaves unset still shows its profile default.
  const resolved = resolveWorkflow({ workflow: value });
  const active = resolved.profile;
  const autoMerge = resolved.autoMerge === "on-green";

  const patch = (p: Partial<WorkflowConfig>) => onChange({ ...value, ...p });

  function pick(profile: WorkflowProfile) {
    if (profile === active || disabled) return;
    patch({ profile });
  }

  return (
    <div className="rounded-md border border-line bg-panel-2/40">
      <div className="flex items-center gap-2 px-3 py-2 [&_svg]:size-3.5">
        <GitPullRequest className="shrink-0 text-muted" />
        <span className="text-sm font-semibold text-primary">Workflow profile</span>
        <Chip tone="info" mono>
          {active}
        </Chip>
        <span className="ml-auto truncate text-2xs text-faint">
          how change ships in this repo
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 border-t border-line-soft px-3 py-2">
        {OPTIONS.map((opt) => {
          const selected = opt.id === active;
          const Icon = opt.icon;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled}
              onClick={() => pick(opt.id)}
              className={cn(
                "rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-60",
                selected
                  ? "border-accent/50 bg-accent-ghost"
                  : "border-line hover:border-line-strong hover:bg-panel-2",
              )}
            >
              <div className="mb-1 flex items-center gap-1.5 [&_svg]:size-3.5">
                <Icon className={selected ? "text-accent" : "text-muted"} />
                <span
                  className={cn(
                    "text-xs font-semibold",
                    selected ? "text-accent" : "text-secondary",
                  )}
                >
                  {opt.label}
                </span>
              </div>
              <p className="text-2xs leading-snug text-faint">{opt.blurb}</p>
              {selected && (
                <ul className="mt-1.5 space-y-0.5 border-t border-line-soft pt-1.5">
                  {opt.effects.map((e) => (
                    <li key={e} className="text-2xs leading-snug text-muted">
                      • {e}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>
      {/* Auto-merge is a sub-setting OF review: the lower rungs have no PR to
          land, so showing the toggle there would only invite a click that does
          nothing. */}
      {active === "review" && (
        <div className="border-t border-line-soft px-3 py-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => patch({ autoMerge: autoMerge ? "off" : "on-green" })}
            role="switch"
            aria-checked={autoMerge}
            className="flex w-full items-start gap-2 text-left disabled:opacity-60"
          >
            <Switch checked={autoMerge} disabled={disabled} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
                <GitMerge className={autoMerge ? "text-accent" : "text-muted"} />
                <span
                  className={cn(
                    "text-xs font-semibold",
                    autoMerge ? "text-accent" : "text-secondary",
                  )}
                >
                  Auto-merge
                </span>
              </span>
              <span className="mt-0.5 block text-2xs leading-snug text-faint">
                Agents land their own PRs with{" "}
                <span className="cm-mono">mcp__dispatch-github__approve_pr</span> once CI is green and
                review is clean — no waiting for a human to click merge. Off means ship and wait.
              </span>
            </span>
          </button>
          {autoMerge && (
            <div className="mt-2 space-y-1.5 border-t border-line-soft pt-2">
              <ul className="space-y-0.5">
                {[
                  "Refuses to merge on a failing or pending check, an unresolved review thread, a draft, or a conflict",
                  "A `hold` label parks one PR without turning this off",
                  "The agent stands down whenever you say not to merge",
                ].map((e) => (
                  <li key={e} className="text-2xs leading-snug text-muted">
                    • {e}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-2xs text-faint">Strategy</span>
                <SegmentedControl
                  segments={MERGE_METHODS}
                  value={resolved.mergeMethod}
                  onChange={(v) => patch({ mergeMethod: v })}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {fromManifest && (
        <p className="border-t border-line-soft px-3 py-1.5 text-2xs text-faint">
          Saving writes <span className="cm-mono">workflow:</span> into{" "}
          {inRepo ? "this repo’s " : "this project’s "}
          <span className="cm-mono">project.yaml</span>
          {inRepo ? " — committable," : " outside the repo — private to this install,"} and your
          comments and key order are preserved.
        </p>
      )}
    </div>
  );
}
