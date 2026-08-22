/**
 * How a Program reads in the sidebar — a mock, shown beside the real board so
 * the "visually distinct" requirement can be judged by COMPARISON rather than
 * by assertion.
 *
 * Three row treatments sit together on purpose: an ordinary chat, a quick
 * action, and a program. A program has to be distinguishable from both, and the
 * quick action is the harder of the two to differ from — it also carries a
 * custom icon and a tint, so "give it an icon" is not by itself an answer.
 *
 * The distinguishing marks proposed here:
 *   - a FILLED square badge rather than a dot or a bare glyph,
 *   - the accent-2 hue, used by nothing else in the roster,
 *   - a progress bar on the row itself (no other chat kind has a completion),
 *   - actor chats nested UNDERNEATH it, the way reviewer chats now nest under
 *     the chat that opened their PR.
 */
import { ChevronDown, Crown, HardHat, MessageSquare, SearchCheck, Sparkles, Target } from "lucide-react";
import { cn } from "../../lib/cn.js";
import type { Plan } from "./derive.js";
import type { Nav } from "./nav.js";

export function SidebarMock({ plan, nav }: { plan: Plan; nav: Nav }) {
  const { spec, run } = plan;
  const done = plan.tasks.filter((t) => run?.tasks[t.id]?.status === "done").length;
  const pct = Math.round((done / plan.tasks.length) * 100);
  const live = (run?.actors ?? []).filter((a) => a.status !== "retired");

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-2 py-2 cm-hairline-b">
        <div className="mb-1 text-[10px] uppercase leading-4 tracking-wide text-faint">
          sidebar · mock
        </div>
        {/* the "New" dropdown, with Program as its own type */}
        <div className="rounded-md border border-line bg-panel-2 p-1">
          <div className="flex items-center gap-1 px-1 py-0.5 text-[10px] leading-4 text-faint">
            New <ChevronDown className="size-2.5" />
          </div>
          <DropRow icon={<MessageSquare className="size-3" />} label="Chat" tint="text-muted" />
          <DropRow icon={<Sparkles className="size-3" />} label="Quick action" tint="text-accent" />
          <DropRow
            icon={<Target className="size-3" />}
            label="Program"
            tint="text-accent-2-hi"
            badge
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-1.5">
        <Row icon={<MessageSquare className="size-3" />} label="fix the viewport dead zone" />
        <Row
          icon={<Sparkles className="size-3" />}
          label="MCP server: add Linear"
          tint="text-accent"
        />

        {/* the program row */}
        <button
          type="button"
          onClick={() => nav.go({ at: "program" })}
          className={cn(
            "mt-0.5 flex w-full items-start gap-1.5 rounded-md border px-1.5 py-1.5 text-left",
            "border-accent-2-line bg-accent-2-ghost",
          )}
        >
          <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-accent-2 text-accent-2-fg">
            <Target className="size-2.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-2xs font-semibold text-primary">
              {spec.title}
            </span>
            <span className="mt-1 flex items-center gap-1">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-inset">
                <span
                  className="block h-full rounded-full bg-accent-2"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="cm-mono text-[9px] leading-3 text-faint">{pct}%</span>
            </span>
          </span>
        </button>

        {/* actors nest under it */}
        <div className="ml-3 border-l border-line pl-1.5">
          {live.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => nav.go({ at: "agent", actorId: a.id })}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
            >
              <span className="shrink-0 text-faint">
                {a.kind === "orchestrator" ? (
                  <Crown className="size-2.5" />
                ) : a.kind === "qa" ? (
                  <SearchCheck className="size-2.5" />
                ) : a.kind === "lead" ? (
                  <Target className="size-2.5" />
                ) : (
                  <HardHat className="size-2.5" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] leading-4 text-muted">
                {a.name}
              </span>
              <span
                className={cn(
                  "size-1 shrink-0 rounded-full",
                  a.status === "running"
                    ? "bg-accent"
                    : a.status === "waiting-human"
                      ? "bg-warn"
                      : a.status === "blocked"
                        ? "bg-danger"
                        : "bg-line-strong",
                )}
              />
            </button>
          ))}
        </div>

        <Row icon={<MessageSquare className="size-3" />} label="pfSense WAN flap" />
      </div>
    </aside>
  );
}

function DropRow({
  icon,
  label,
  tint,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  tint: string;
  badge?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded px-1 py-0.5">
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-[3px]",
          badge ? "bg-accent-2 text-accent-2-fg" : tint,
        )}
      >
        {icon}
      </span>
      <span className={cn("text-[10px] leading-4", badge ? "font-semibold text-primary" : "text-secondary")}>
        {label}
      </span>
    </div>
  );
}

function Row({ icon, label, tint }: { icon: React.ReactNode; label: string; tint?: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1">
      <span className={cn("shrink-0", tint ?? "text-faint")}>{icon}</span>
      <span className="truncate text-2xs text-muted">{label}</span>
    </div>
  );
}
