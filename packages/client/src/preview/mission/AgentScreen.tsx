/**
 * One agent — its persona, the toolset that actually resolved, and its live
 * state.
 *
 * The tool section shows the RESOLUTION, not just the outcome: the profile it
 * inherited, the overrides the mission manager applied, and the effective
 * deny-list the session will really be built with. Showing only the final list
 * is how a widened profile quietly stops matching what anyone intended.
 */
import { MessageSquare } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { ActorStatusPill, ContextBar, Empty, Section, Tunable } from "./chrome.js";
import { teamColor, type Plan } from "./derive.js";
import type { Nav } from "./nav.js";
import type { SectionState } from "./sections.js";
import { CAPS, TOOL_PROFILES, effectiveDeny, effectiveProfile, type Persona } from "./types.js";

export function AgentScreen({
  plan,
  actorId,
  sections,
}: {
  plan: Plan;
  actorId: string;
  nav: Nav;
  sections: SectionState;
}) {
  const { spec, run } = plan;
  const actor = run?.actors.find((a) => a.id === actorId);
  if (!actor) return <div className="p-4 text-xs text-faint">no such agent</div>;

  const team = spec.teams.find((t) => t.id === actor.teamId);
  const role = spec.roles.find((r) => r.id === actor.roleTemplateId);

  // Which persona backs this actor: the orchestrator, the QA template, the
  // team's lead, or — for a hire — the role template the lead picked.
  const persona: Persona =
    actor.kind === "orchestrator"
      ? spec.orchestrator
      : actor.kind === "qa"
        ? spec.qa
        : actor.kind === "lead" && team
          ? team.lead
          : {
              name: actor.name,
              roleTemplateId: actor.roleTemplateId,
              instructions: role?.instructions,
              skills: role?.skills,
              effort: role?.effort,
            };

  const profileId = effectiveProfile(persona, spec.roles);
  const profile = TOOL_PROFILES[profileId];
  const deny = effectiveDeny(persona, spec.roles);
  const allowed = persona.toolOverrides?.allow ?? [];
  const added = persona.toolOverrides?.deny ?? [];
  const threshold = spec.policy.leadRecycle.contextThreshold;
  const color = actor.teamId ? teamColor(spec, actor.teamId) : "var(--p-accent)";
  const skills = persona.skills ?? role?.skills ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section
        id="agent-live"
        title="Live state"
        state={sections}
        hint="what the engine will report once the run is real"
        right={<span className="text-[10px] leading-4 text-faint">not wired — shape only</span>}
      >
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <Chip tone="accent">{actor.kind}</Chip>
          {role && (
            <Chip tone="neutral" mono>
              {role.id}
            </Chip>
          )}
          {team && (
            <Chip tone="neutral">
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ background: color }} />
                {team.name}
              </span>
            </Chip>
          )}
          <ActorStatusPill status={actor.status} />
          {role?.freshContext && <Chip tone="info">fresh context every engagement</Chip>}
        </div>

        <div className="max-w-3xl rounded-lg border border-line bg-panel p-2.5">
          <p className="text-xs leading-relaxed text-primary">{actor.activity}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-5">
            <div>
              <div className="text-[10px] leading-4 text-faint">context</div>
              <div className="mt-0.5">
                <ContextBar fill={actor.contextFill} threshold={threshold} />
              </div>
            </div>
            <div>
              <div className="text-[10px] leading-4 text-faint">chat</div>
              <button
                type="button"
                className="mt-0.5 flex items-center gap-1 rounded text-2xs text-muted hover:text-primary"
                title="Opens the actor's own chat — wired once the chat type lands"
              >
                <MessageSquare className="size-3" />
                <span className="cm-mono">{actor.chatId}</span>
              </button>
            </div>
            {actor.retiredAt && (
              <div>
                <div className="text-[10px] leading-4 text-faint">retired</div>
                <div className="mt-0.5 text-2xs text-muted">
                  {new Date(actor.retiredAt).toLocaleTimeString()}
                </div>
              </div>
            )}
          </div>
          {actor.status === "retired" && actor.contextFill >= threshold && (
            <p className="mt-2 rounded border border-warn-line bg-warn-ghost px-2 py-1 text-2xs text-warn">
              Retired over the {Math.round(threshold * 100)}% threshold — its handoff is what
              carried forward, not its transcript.
            </p>
          )}
        </div>
      </Section>

      <Section
        id="agent-why"
        title="Why this role"
        state={sections}
        hint="the lead's reason, recorded at hire time"
      >
        {actor.hiredBecause ? (
          <p className="max-w-3xl rounded-lg border border-line bg-panel p-2.5 text-2xs leading-relaxed text-secondary">
            {actor.hiredBecause}
          </p>
        ) : (
          <Empty>not a hire — this actor is part of the mission's standing structure</Empty>
        )}
      </Section>

      <Section id="agent-tools" title="Toolset" state={sections} hint={profile.summary}>
        <div className="max-w-3xl rounded-lg border border-line bg-panel p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tunable label="profile" value={profile.name} />
            <Tunable label="effort" value={persona.effort ?? role?.effort ?? "inherit"} />
            <Tunable label="model" value={persona.model ?? "inherit"} />
          </div>

          {(allowed.length > 0 || added.length > 0) && (
            <div className="mt-2 rounded border border-accent-line bg-accent-ghost px-2 py-1.5">
              <div className="text-[10px] leading-4 text-accent-hi">manager overrides</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {allowed.map((t) => (
                  <span
                    key={t}
                    className="cm-mono rounded bg-success-ghost px-1 text-[10px] leading-4 text-success-hi"
                  >
                    +{t}
                  </span>
                ))}
                {added.map((t) => (
                  <span
                    key={t}
                    className="cm-mono rounded bg-danger-ghost px-1 text-[10px] leading-4 text-danger-hi"
                  >
                    −{t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2">
            <div className="text-[10px] leading-4 text-faint">
              effective deny — enforced at spawn
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {deny.length === 0 ? (
                <Empty>nothing blocked</Empty>
              ) : (
                deny.map((t) => (
                  <span
                    key={t}
                    className={cn(
                      "cm-mono rounded border px-1 text-[10px] leading-4",
                      "border-danger-line bg-danger-ghost text-danger-hi",
                    )}
                  >
                    {t}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </Section>

      <Section id="agent-skills" title="Skills" state={sections} hint="materialized into the session">
        {skills.length === 0 ? (
          <Empty>none — no skill profile for this role</Empty>
        ) : (
          <div className="flex flex-wrap gap-1">
            {skills.map((s) => (
              <span
                key={s}
                className="cm-mono rounded border border-line bg-panel-2 px-1.5 py-px text-[10px] leading-4 text-secondary"
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section
        id="agent-instructions"
        title="Instructions"
        state={sections}
        hint={role ? "role template default, plus any persona override" : "authored on the persona"}
        right={
          <span className="cm-mono text-[10px] leading-4 text-faint">
            {(persona.instructions ?? "").length}/{CAPS.personaInstructions}
          </span>
        }
      >
        <div className="max-w-4xl rounded-lg border border-line bg-panel p-2.5">
          <p className="whitespace-pre-wrap text-2xs leading-relaxed text-secondary">
            {persona.instructions ?? `reuses configured agent "${persona.agentId}"`}
          </p>
        </div>
      </Section>

      <Section
        id="agent-hires"
        title="Hire menu"
        state={sections}
        hint="what this lead may choose from"
      >
        {actor.kind !== "lead" || !team ? (
          <Empty>only a team lead hires</Empty>
        ) : (
          <div className="max-w-3xl">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Tunable label="budget" value={team.hireBudget} />
              <span className="text-[10px] leading-4 text-faint">
                concurrent workers, spent however the lead likes
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {team.hireableRoles.map((rid) => {
                const r = spec.roles.find((x) => x.id === rid);
                return (
                  <div key={rid} className="rounded border border-line bg-panel px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-2xs font-medium text-primary">{r?.name ?? rid}</span>
                      <Chip tone="neutral">{r?.toolProfile}</Chip>
                      {r?.freshContext && <Chip tone="info">fresh context</Chip>}
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted">{r?.summary}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
