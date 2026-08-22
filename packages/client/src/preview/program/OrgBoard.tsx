/**
 * The org view — who exists, who they answer to, and what each persona is.
 *
 * Drawn as the actual escalation chain rather than an org chart for its own
 * sake, because the chain IS the design: a developer can only reach its own
 * lead, a lead can only reach the RTE, and only the RTE reaches you. Every edge
 * that isn't drawn here is one the engine refuses.
 */
import { Bot, Crown, HardHat, MessagesSquare, ShieldOff, User } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { teamColor } from "./derive.js";
import type { Persona, ProgramSpec } from "./types.js";
import { SectionTitle } from "./PlanBoard.js";

export interface PersonaPick {
  persona: Persona;
  role: string;
  teamId?: string;
}

interface Props {
  spec: ProgramSpec;
  onPersona: (p: PersonaPick) => void;
  selected?: string;
}

export function OrgBoard({ spec, onPersona, selected }: Props) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <SectionTitle icon={<MessagesSquare className="size-3.5" />} label="Escalation chain">
        a developer reaches only its own lead; leads reach each other only through the RTE
      </SectionTitle>

      {/* creator */}
      <ActorRow
        tone="human"
        icon={<User className="size-3.5" />}
        title="Workflow Creator"
        subtitle="you + the chat that authored this program — full tools, the only human comms path"
        badge="not a persona"
      />
      <Spine />

      {/* orchestrator */}
      <ActorRow
        tone="rte"
        icon={<Crown className="size-3.5" />}
        title={spec.orchestrator.name}
        subtitle="routes cross-team traffic, convenes gates, filters what reaches you — schedules nothing"
        badge={`effort ${spec.orchestrator.effort ?? "inherit"}`}
        onClick={() => onPersona({ persona: spec.orchestrator, role: "Orchestrator (RTE)" })}
        active={selected === "Orchestrator (RTE)"}
        gated={spec.orchestrator.disallowedTools}
      />
      <Spine />

      {/* teams */}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
        {spec.teams.map((team) => {
          const tasks = spec.tasks.filter((t) => t.teamId === team.id);
          const phases = [...new Set(tasks.map((t) => t.phaseId))];
          const color = teamColor(spec, team.id);
          return (
            <div
              key={team.id}
              className="overflow-hidden rounded-lg border border-line bg-panel"
              style={{ borderTopColor: color, borderTopWidth: 2 }}
            >
              <div className="px-2.5 pb-1.5 pt-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-primary">{team.name}</span>
                  <span className="ml-auto cm-mono text-2xs text-faint">{team.id}</span>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-muted">{team.charter}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Chip tone="neutral">
                    {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                  </Chip>
                  <Chip tone="neutral">
                    {phases.length} {phases.length === 1 ? "phase" : "phases"}
                  </Chip>
                  <Chip tone="neutral">max {team.maxParallel}</Chip>
                </div>
              </div>

              <div className="flex flex-col gap-1 px-2 pb-2">
                <PersonaRow
                  icon={<Bot className="size-3" />}
                  label="Lead"
                  persona={team.lead}
                  color={color}
                  onClick={() =>
                    onPersona({ persona: team.lead, role: `${team.name} Lead`, teamId: team.id })
                  }
                  active={selected === `${team.name} Lead`}
                />
                <PersonaRow
                  icon={<HardHat className="size-3" />}
                  label={`Developer ×${team.maxParallel}`}
                  persona={team.developer}
                  color={color}
                  onClick={() =>
                    onPersona({
                      persona: team.developer,
                      role: `${team.name} Developer`,
                      teamId: team.id,
                    })
                  }
                  active={selected === `${team.name} Developer`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 rounded-lg border border-line bg-panel-2 p-3">
        <SectionTitle icon={<ShieldOff className="size-3.5" />} label="What the gating buys">
          enforced by tool exclusion at spawn, not requested in prose
        </SectionTitle>
        <ul className="flex flex-col gap-1 text-2xs leading-relaxed text-secondary">
          <li>
            <b className="text-primary">Leads and the RTE cannot edit.</b> Edit, Write and
            NotebookEdit are excluded, so "makes no code changes" is a property of the session
            rather than a hope about the prompt.
          </li>
          <li>
            <b className="text-primary">Leads cannot open or land PRs.</b> create_pr and approve_pr
            are excluded; a lead that wants a PR override raises an escalation instead — the rule
            PR #15 established, kept intact.
          </li>
          <li>
            <b className="text-primary">The RTE cannot run commands.</b> No Bash, no terminal. It
            has no way to start doing the work it is supposed to be coordinating.
          </li>
        </ul>
      </div>
    </div>
  );
}

function Spine() {
  return <div className="ml-[1.1rem] h-4 w-px bg-line-strong" />;
}

function ActorRow({
  tone,
  icon,
  title,
  subtitle,
  badge,
  onClick,
  active,
  gated,
}: {
  tone: "human" | "rte";
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
  onClick?: () => void;
  active?: boolean;
  gated?: string[];
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && e.key === "Enter" && onClick()}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-2.5 py-2",
        onClick && "cursor-pointer hover:border-line-strong",
        active
          ? "border-accent-line bg-accent-ghost"
          : tone === "human"
            ? "border-line-strong bg-panel-2"
            : "border-line bg-panel",
      )}
    >
      <span
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded",
          tone === "human" ? "bg-inset text-secondary" : "bg-accent-ghost text-accent-hi",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-primary">{title}</span>
          {badge && <Chip tone="neutral">{badge}</Chip>}
          {gated?.length ? <Chip tone="warn">{gated.length} tools blocked</Chip> : null}
        </div>
        <p className="mt-0.5 text-2xs leading-relaxed text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

function PersonaRow({
  icon,
  label,
  persona,
  color,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  persona: Persona;
  color: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
        active
          ? "border-accent-line bg-accent-ghost"
          : "border-line-soft bg-panel-2 hover:border-line-strong",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded" style={{ color }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium text-primary">{persona.name}</span>
        <span className="block text-[10px] leading-4 text-faint">{label}</span>
      </span>
      {persona.effort && <Chip tone="neutral">{persona.effort}</Chip>}
    </button>
  );
}
