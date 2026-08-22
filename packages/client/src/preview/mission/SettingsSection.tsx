/**
 * Mission settings — the owner's section, with real inputs.
 *
 * These are live in the preview: changing `maxParallelTasks` or a team's hire
 * budget re-derives the concurrency preview on every phase screen immediately.
 * That is deliberate rather than showmanship — the whole reason these belong on
 * the board instead of in a config file is that their effect is not obvious
 * from the number, and a form you can move while watching the schedule change
 * is the only honest way to pick one.
 *
 * The bounds on each control are the SCHEMA's bounds, not styling. A stepper
 * that cannot leave the valid range is the cheapest validator there is.
 */
import { CircleAlert, RotateCcw } from "lucide-react";
import { Select } from "../../components/ui/index.js";
import { FormRow, LockedRow, NumberInput, PercentSlider } from "./chrome.js";
import { teamColor } from "./derive.js";
import type { MissionPolicy, MissionSpec, TeamId } from "./types.js";

export interface SettingsDraft {
  policy: MissionPolicy;
  hireBudgets: Record<TeamId, number>;
}

export function SettingsSection({
  spec,
  draft,
  dirty,
  onChange,
  onReset,
}: {
  spec: MissionSpec;
  draft: SettingsDraft;
  dirty: boolean;
  onChange: (next: SettingsDraft) => void;
  onReset: () => void;
}) {
  const set = (patch: Partial<MissionPolicy>) =>
    onChange({ ...draft, policy: { ...draft.policy, ...patch } });
  const setBudget = (teamId: TeamId, n: number) =>
    onChange({ ...draft, hireBudgets: { ...draft.hireBudgets, [teamId]: n } });

  const totalBudget = Object.values(draft.hireBudgets).reduce((a, b) => a + b, 0);
  const overSubscribed = totalBudget > draft.policy.maxParallelTasks;

  return (
    <div className="max-w-4xl">
      {dirty && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-accent-line bg-accent-ghost px-2.5 py-1.5">
          <span className="flex-1 text-2xs text-accent-hi">
            Changed — every derived view on this board is already using these values.
          </span>
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-line-strong hover:text-primary"
          >
            <RotateCcw className="size-2.5" />
            Revert
          </button>
        </div>
      )}

      <div className="divide-y divide-line-soft">
        <FormRow
          label="Concurrent hires"
          help="Mission-wide ceiling across every team. The engine will not start a task past it."
        >
          <NumberInput
            value={draft.policy.maxParallelTasks}
            min={1}
            max={12}
            suffix="chats at once"
            onChange={(n) => set({ maxParallelTasks: n })}
          />
        </FormRow>

        <FormRow
          label="Branching"
          help="How a dependency is satisfied. Serialize-on-merge waits for every PR on the dependency, because a task may open more than one."
        >
          <Select
            value={draft.policy.branching}
            width={210}
            onChange={(v) => set({ branching: v as MissionPolicy["branching"] })}
            options={[
              { value: "serialize-on-merge", label: "Serialize on merge", hint: "clean history" },
              { value: "stacked", label: "Stacked PRs", hint: "faster, messier review" },
            ]}
          />
        </FormRow>

        <FormRow
          label="Lead recycle at"
          help="Context fill that retires a lead and hands its successor a capped handoff. Read from the broker, never asked of the lead."
        >
          <PercentSlider
            value={draft.policy.leadRecycle.contextThreshold}
            min={0.3}
            max={0.9}
            onChange={(v) =>
              set({ leadRecycle: { ...draft.policy.leadRecycle, contextThreshold: v } })
            }
          />
        </FormRow>

        <FormRow
          label="QA round cap"
          help="How many times QA may send a phase back before it becomes your decision instead of the RTE's."
        >
          <NumberInput
            value={draft.policy.maxRemediationRounds}
            min={0}
            max={5}
            suffix="rounds, then escalate"
            onChange={(n) => set({ maxRemediationRounds: n })}
          />
        </FormRow>

        <FormRow
          label="On task failure"
          help="What the engine does when a hire reports failed."
        >
          <Select
            value={draft.policy.onTaskFailure}
            width={210}
            onChange={(v) => set({ onTaskFailure: v as MissionPolicy["onTaskFailure"] })}
            options={[
              { value: "escalate", label: "Escalate", hint: "ask the RTE" },
              { value: "retry-once", label: "Retry once", hint: "then escalate" },
              { value: "halt-phase", label: "Halt the phase", hint: "stop everything" },
            ]}
          />
        </FormRow>

        <FormRow
          label="Spawn consent"
          help="Per-spawn prompts you for every hire — a five-phase mission asks dozens of times. Mission-grant asks once, at approval."
        >
          <Select
            value={draft.policy.spawnConsent}
            width={210}
            onChange={(v) => set({ spawnConsent: v as MissionPolicy["spawnConsent"] })}
            options={[
              { value: "mission-grant", label: "Mission grant", hint: "approve once, at start" },
              { value: "per-spawn", label: "Per spawn", hint: "prompt every hire" },
            ]}
          />
        </FormRow>

        <FormRow label="PR override">
          <LockedRow
            value="escalate"
            why="Pinned by the schema. A lead may request an override; it can never grant itself one — relaxing this would make the permission card PR #15 introduced unreachable."
          />
        </FormRow>
      </div>

      {/* ------------------------------------------------------ per team */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-secondary">Hire budgets</span>
          <span className="text-2xs text-faint">
            concurrent workers each lead may hold — spent however the lead likes
          </span>
        </div>

        {overSubscribed && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md border border-warn-line bg-warn-ghost px-2 py-1.5">
            <CircleAlert className="mt-px size-3 shrink-0 text-warn" />
            <span className="text-2xs leading-relaxed text-warn">
              Budgets total {totalBudget} but the mission ceiling is{" "}
              {draft.policy.maxParallelTasks}. That is legal — the ceiling wins — but it means
              teams will compete for slots and a lead can be refused a hire it has budget for.
            </span>
          </div>
        )}

        <div className="divide-y divide-line-soft">
          {spec.teams.map((team) => (
            <FormRow key={team.id} label={team.name} help={team.charter}>
              <div className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: teamColor(spec, team.id) }}
                />
                <NumberInput
                  value={draft.hireBudgets[team.id] ?? team.hireBudget}
                  min={1}
                  max={5}
                  onChange={(n) => setBudget(team.id, n)}
                />
                <span className="text-[10px] leading-4 text-faint">
                  can hire {team.hireableRoles.join(", ")}
                </span>
              </div>
            </FormRow>
          ))}
        </div>
      </div>
    </div>
  );
}
