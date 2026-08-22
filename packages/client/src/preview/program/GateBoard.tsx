/**
 * The gate board — every acceptance criterion, and which leads have to agree.
 *
 * The signatory column is the whole point of this view: it is DERIVED from
 * `task.satisfies`, so it cannot drift from the plan, and it makes two plan
 * bugs visible at a glance — a criterion with no signatories (nobody is
 * building it, so it can never be declared met) and a criterion with four
 * (every done-agreement on it needs four leads to converge, which is a cost
 * worth seeing before the run starts, not during it).
 */
import { CheckCircle2, CircleDot, Terminal, TriangleAlert, UserCheck } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { gatePreviews, teamColor } from "./derive.js";
import type { Criterion, ProgramSpec } from "./types.js";
import { SectionTitle } from "./PlanBoard.js";

const VERIFY_ICON = {
  command: <Terminal className="size-3" />,
  review: <UserCheck className="size-3" />,
  human: <CircleDot className="size-3" />,
} as const;

export function GateBoard({
  spec,
  onCriterion,
  selected,
}: {
  spec: ProgramSpec;
  onCriterion: (c: Criterion) => void;
  selected?: string;
}) {
  const gates = gatePreviews(spec);
  const program = gates.filter((g) => g.scope === "program");
  const byPhase = spec.phases.map((p) => ({
    phase: p,
    gates: gates.filter((g) => g.phaseId === p.id),
  }));

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <SectionTitle icon={<CheckCircle2 className="size-3.5" />} label="Program done-agreement">
        every involved lead must vote met; one not-met disputes the gate and the RTE mediates
      </SectionTitle>
      <div className="flex flex-col gap-1.5">
        {program.map((g) => (
          <GateRow
            key={g.criterion.id}
            spec={spec}
            gate={g}
            onClick={() => onCriterion(g.criterion)}
            active={selected === g.criterion.id}
          />
        ))}
      </div>

      {byPhase
        .filter((b) => b.gates.length > 0)
        .map(({ phase, gates: pg }) => (
          <div key={phase.id} className="mt-5">
            <SectionTitle
              icon={
                <span className="cm-mono flex size-4 items-center justify-center rounded bg-inset text-2xs text-muted">
                  {phase.order}
                </span>
              }
              label={`${phase.title} — phase gate`}
            >
              exit: {phase.exit}
            </SectionTitle>
            <div className="flex flex-col gap-1.5">
              {pg.map((g) => (
                <GateRow
                  key={g.criterion.id}
                  spec={spec}
                  gate={g}
                  onClick={() => onCriterion(g.criterion)}
                  active={selected === g.criterion.id}
                />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function GateRow({
  spec,
  gate,
  onClick,
  active,
}: {
  spec: ProgramSpec;
  gate: ReturnType<typeof gatePreviews>[number];
  onClick: () => void;
  active?: boolean;
}) {
  const { criterion: c, signatories, satisfiedBy, implied } = gate;
  const orphan = signatories.length === 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className={cn(
        "cursor-pointer rounded-lg border px-2.5 py-2 transition-colors",
        active
          ? "border-accent-line bg-accent-ghost"
          : orphan
            ? "border-danger-line bg-danger-ghost"
            : "border-line bg-panel hover:border-line-strong",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-primary">{c.title}</span>
        <span className="cm-mono text-2xs text-faint">{c.id}</span>
        <Chip tone={c.verify === "command" ? "success" : c.verify === "human" ? "warn" : "info"}>
          <span className="flex items-center gap-1">
            {VERIFY_ICON[c.verify]}
            {c.verify}
          </span>
        </Chip>
        <span className="ml-auto flex items-center gap-1.5">
          {orphan ? (
            <span className="flex items-center gap-1 text-2xs text-danger">
              <TriangleAlert className="size-3" />
              no task satisfies this
            </span>
          ) : (
            <>
              <span className="text-2xs text-faint">
                {implied ? "whole phase signs" : signatories.length === 1 ? "1 signatory" : `${signatories.length} signatories`}
              </span>
              {signatories.map((tid) => {
                const team = spec.teams.find((t) => t.id === tid);
                return (
                  <span
                    key={tid}
                    title={team?.name ?? tid}
                    className="flex items-center gap-1 rounded border border-line bg-panel-2 px-1.5 py-px text-2xs text-secondary"
                  >
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: teamColor(spec, tid) }}
                    />
                    {team?.name ?? tid}
                  </span>
                );
              })}
            </>
          )}
        </span>
      </div>

      <div className="mt-1.5 grid gap-x-3 gap-y-0.5 text-2xs leading-relaxed [grid-template-columns:2.6rem_1fr]">
        {c.given && (
          <>
            <span className="cm-mono text-faint">given</span>
            <span className="text-muted">{c.given}</span>
          </>
        )}
        {c.when && (
          <>
            <span className="cm-mono text-faint">when</span>
            <span className="text-muted">{c.when}</span>
          </>
        )}
        <span className="cm-mono text-faint">then</span>
        <span className="text-secondary">{c.then}</span>
      </div>

      {satisfiedBy.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {satisfiedBy.map((t) => (
            <span
              key={t.id}
              className="cm-mono rounded bg-inset px-1 text-[10px] leading-4 text-muted"
            >
              {t.id}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
