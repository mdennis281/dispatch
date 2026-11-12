import { useState } from "react";
import { AlertTriangle, Power } from "lucide-react";
import type { PluginInfo, PluginInspection } from "@dispatch/shared";
import { Modal, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { StatusDot } from "../../ui/StatusDot.js";
import { dependencySource, dependencyTone } from "./pluginDependencyPlan.js";

/**
 * Settings → Plugins: one plugin using another (docs/plugins.md →
 * "Dependencies"). Every sentence here is the server's — the report's
 * consent `line`, the resolver's `detail` — laid out; nothing is decided.
 */

const toneText = { success: "text-success", warn: "text-warn", danger: "text-danger", muted: "text-muted" } as const;

/**
 * The server's consent sentences mark API names with backticks (they are the
 * same text the CLI prints); here those read as code, not as stray ticks.
 */
function Sentence({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i} className="cm-mono !text-2xs text-primary">{part}</code> : part))}</>;
}

function SectionHeading({ children }: { children: string }) {
  return <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">{children}</div>;
}

/**
 * The report's "Other plugins" section: what this one would use of others —
 * a trust grant like a capability, so it reads as a consent sentence — what
 * it offers them, and, in red, the installed plugins replacing it would break.
 */
export function ReportDependencies({ report: r }: { report: PluginInspection }) {
  const deps = r.dependencies ?? [];
  const breaks = r.breaks ?? [];
  if (!deps.length && !r.providesLine && !breaks.length) return null;
  return (
    <section className="border-t border-line-soft pt-2" data-testid="plugin-inspection-dependencies">
      <SectionHeading>Other plugins</SectionHeading>
      {breaks.map((b) => (
        <p
          key={`breaks-${b.id}`}
          className="flex items-start gap-1.5 py-0.5 text-2xs leading-relaxed text-danger [&_svg]:mt-0.5 [&_svg]:size-3 [&_svg]:shrink-0"
        >
          <AlertTriangle />
          <span className="min-w-0">
            <span className="font-medium">Breaks {b.id}</span> — {b.detail}. It stops until it is updated too.
          </span>
        </p>
      ))}
      <div className="space-y-1">
        {deps.map((d) => {
          const tone = dependencyTone(d.state);
          return (
            <div key={d.id} className="text-2xs leading-relaxed">
              <p className="text-secondary">
                <Sentence text={d.line} />
              </p>
              <p className={`flex items-center gap-1.5 ${d.from === "collection" ? "text-info" : toneText[tone]}`}>
                <StatusDot tone={d.from === "collection" ? "info" : tone} />
                <span className="min-w-0">{dependencySource(d)}</span>
              </p>
            </div>
          );
        })}
      </div>
      {r.providesLine && (
        <p className="mt-1 text-2xs leading-relaxed text-secondary">
          <Sentence text={r.providesLine} />
        </p>
      )}
    </section>
  );
}

/**
 * The confirmation a breaking replace needs: the owner types the plugin's id.
 * A click-through would be the same click that started it; typing the id is
 * a second, deliberate act — the update can stop another plugin outright.
 */
export function BreakingConfirm({
  id,
  breaks,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  id: string;
  breaks: ReadonlyArray<{ id: string; detail: string }>;
  action: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="space-y-1.5 rounded-md border border-danger/30 bg-danger-ghost px-2.5 py-2" data-testid="plugin-breaking-confirm">
      <p className="text-xs font-medium text-danger">
        This breaks {breaks.map((b) => b.id).join(", ")}
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-2xs leading-relaxed text-danger">
        {breaks.map((b) => (
          <li key={b.id}>
            {b.id}: {b.detail}
          </li>
        ))}
      </ul>
      <p className="text-2xs leading-relaxed text-secondary">
        {breaks.length === 1 ? "It is" : "They are"} blocked from the next restart until updated to a version that works with this one. Type{" "}
        <code className="cm-mono !text-2xs text-primary">{id}</code> to {action.toLowerCase()} anyway.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <TextInput
          mono
          className="!h-7 min-w-0 flex-1 basis-40"
          value={typed}
          placeholder={id}
          aria-label={`Type ${id} to confirm`}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" disabled={busy || typed.trim() !== id} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    </div>
  );
}

/**
 * On an installed plugin's card: what it uses, live (the resolver's verdict
 * folded with what is running), who uses it, and what it offers.
 */
export function CardDependencies({ plugin, all }: { plugin: PluginInfo; all: readonly PluginInfo[] }) {
  const deps = plugin.dependencies ?? [];
  const users = (plugin.dependents ?? []).map((id) => {
    const p = all.find((x) => x.id === id);
    return { id, name: p?.name ?? id, optional: !!p?.dependencies?.find((d) => d.id === plugin.id)?.optional };
  });
  const provides = plugin.provides ?? [];
  if (!deps.length && !users.length && !provides.length) return null;
  const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="space-y-1.5 rounded-md bg-inset/40 px-2.5 py-2 text-2xs leading-relaxed" data-testid={`plugin-dependencies-${plugin.id}`}>
      {deps.length > 0 && (
        <div>
          <SectionHeading>Uses</SectionHeading>
          {deps.map((d) => {
            const tone = dependencyTone(d.state);
            return (
              <div key={d.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5">
                <span className="inline-flex items-center gap-1.5 text-secondary">
                  <StatusDot tone={tone} />
                  {nameOf(d.id)}
                </span>
                <span className="cm-mono !text-2xs text-faint">{d.uses.join(", ")}</span>
                {d.optional && <Chip tone="muted">optional</Chip>}
                <span className={`min-w-0 ${d.state === "ok" ? "text-muted" : toneText[tone]}`}>
                  {d.state === "ok" ? "running" : d.optional ? `${d.detail} — runs without it, with less` : d.detail}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {users.length > 0 && (
        <div>
          <SectionHeading>Used by</SectionHeading>
          <p className="text-secondary">
            {users.map((u, i) => (
              <span key={u.id}>
                {i > 0 && ", "}
                {u.name}
                {u.optional ? <span className="text-faint"> (optional)</span> : null}
              </span>
            ))}
          </p>
          <p className="text-faint">Switching this off stops what needs it; Uninstall waits until nothing uses it.</p>
        </div>
      )}
      {provides.length > 0 && (
        <div>
          <SectionHeading>Lets other plugins use</SectionHeading>
          <p className="cm-mono !text-2xs text-secondary">{provides.join(", ")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Switching a provider off is allowed — it is how the owner stops it — but
 * never silently: the confirm names what stops with it and what keeps
 * running with less.
 */
export function DisableDependentsDialog({
  plugin,
  stops,
  degrades,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  plugin: PluginInfo;
  stops: readonly PluginInfo[];
  degrades: readonly PluginInfo[];
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      width={440}
      icon={<Power />}
      title={`Switch off ${plugin.name}?`}
      description={plugin.id}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {stops.length ? `Switch off ${stops.length + 1} plugins` : "Switch off"}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5 text-xs leading-relaxed" data-testid="plugin-disable-dependents">
        {stops.length > 0 && (
          <div>
            <p className="font-medium text-danger">Stops — they need it</p>
            <ul className="list-disc pl-4 text-secondary">
              {stops.map((p) => (
                <li key={p.id}>
                  {p.name} <span className="cm-mono !text-2xs text-faint">{p.id}</span> — stopped now, and blocked until {plugin.name} is back on
                </li>
              ))}
            </ul>
          </div>
        )}
        {degrades.length > 0 && (
          <div>
            <p className="font-medium text-warn">Keeps running, with less — they can use it</p>
            <ul className="list-disc pl-4 text-secondary">
              {degrades.map((p) => (
                <li key={p.id}>
                  {p.name} <span className="cm-mono !text-2xs text-faint">{p.id}</span> — told it is gone, and carries on without it
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Enabling is not live (the host activates at boot), so neither is their return. */}
        <p className="text-2xs text-muted">Switching {plugin.name} back on brings them back on the next restart.</p>
      </div>
    </Modal>
  );
}
