import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, GitCommitHorizontal, ScanSearch } from "lucide-react";
import type { PluginHook, PluginInspection } from "@dispatch/shared";
import { InlineError, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { StatusDot } from "../../ui/StatusDot.js";
import { api } from "../../../lib/api.js";
import { fieldsFromSchema } from "./pluginSettingsForm.js";

/**
 * Settings → Plugins → Inspect from URL (#399).
 *
 * The report is laid out for SCANNING, top to bottom in the order the owner
 * should care: what it is and whether it can run here, then what is wrong
 * (mismatches first — a plugin using `chats:write` it never declared is the
 * single most useful thing this card can say), then what it asked for, what it
 * contributes, and what the code was seen doing. Install sits UNDER all of
 * that on purpose.
 *
 * Nothing here is generated: every line is a field of `PluginInspection`,
 * which the server built from the manifest, the README and a token scan.
 */
export function PluginInspectPanel({ onInstalled }: { onInstalled: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PluginInspection | null>(null);

  const inspect = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.plugins.inspect(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-md border border-line-soft px-3 py-2.5" data-testid="plugin-inspect">
      <div>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-primary [&_svg]:size-4 [&_svg]:text-muted">
          <ScanSearch />
          Inspect from URL
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          Paste a GitHub or https git URL. Dispatch reads the plugin&apos;s files at one commit and reports what it
          is and what it hooks into — nothing is run, built or installed until you press Install.
        </p>
      </div>
      <form className="flex flex-wrap items-center gap-1.5" onSubmit={(e) => void inspect(e)}>
        <TextInput
          mono
          className="min-w-0 flex-1 basis-56"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/path"
          aria-label="Plugin URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          leftIcon={busy ? <Spinner size={12} /> : <ScanSearch />}
          disabled={busy || !url.trim()}
        >
          {busy ? "Inspecting…" : "Inspect"}
        </Button>
      </form>
      <InlineError message={error} />
      {report && <InspectionReport report={report} onInstalled={onInstalled} />}
    </div>
  );
}

/* ---------------------------------------------------------------- report */

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
      {count !== undefined && <span className="font-normal normal-case tracking-normal">· {count}</span>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-t border-line-soft pt-2">
      <Heading count={count}>{title}</Heading>
      {children}
    </section>
  );
}

/** A two-part row: a mono key and its explanation; wraps under itself at phone width. */
function Row({ name, children, tone }: { name: ReactNode; children?: ReactNode; tone?: "warn" | "danger" }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-xs">
      <span
        className={
          tone === "danger" ? "cm-mono !text-2xs text-danger" : tone === "warn" ? "cm-mono !text-2xs text-warn" : "cm-mono !text-2xs text-secondary"
        }
      >
        {name}
      </span>
      {children && <span className="min-w-0 text-2xs leading-relaxed text-muted">{children}</span>}
    </div>
  );
}

const HOOK_GROUPS: Array<{ kind: PluginHook["kind"]; title: string }> = [
  { kind: "event", title: "Events" },
  { kind: "route", title: "Routes" },
  { kind: "slot", title: "UI slots" },
  { kind: "engine", title: "Engines" },
  { kind: "chat", title: "Per-chat" },
  { kind: "api", title: "Host APIs" },
  { kind: "io", title: "Outside Dispatch" },
];

function verdict(r: PluginInspection): { tone: "success" | "warn" | "danger"; label: string } {
  if (!r.valid) return { tone: "danger", label: "Invalid manifest" };
  if (!r.compatibility.compatible) return { tone: "warn", label: `Incompatible (needs ${r.compatibility.range ?? "?"})` };
  return { tone: "success", label: `Compatible · API ${r.compatibility.hostApi}` };
}

function InspectionReport({ report: r, onInstalled }: { report: PluginInspection; onInstalled: () => void }) {
  const v = verdict(r);
  const c = r.contributions;
  const contributionCount =
    c.modes.length + c.skills.length + c.instructions.length + c.personas.length + c.mcpServers.length + c.processes.length;
  const { fields, unsupported } = fieldsFromSchema(r.settingsSchema);
  const problems = r.mismatches.undeclared.length + r.mismatches.unused.length + r.warnings.length;

  return (
    <div className="space-y-2 rounded-md bg-inset/40 px-2.5 py-2" data-testid="plugin-inspection">
      {/* -- header ------------------------------------------------------ */}
      <div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-primary">{r.name ?? r.id ?? "Unnamed plugin"}</span>
          {r.version && <Chip mono>v{r.version}</Chip>}
          <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
            <StatusDot tone={v.tone} />
            {v.label}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {r.id && (
            <Chip mono tone="muted">
              {r.id}
            </Chip>
          )}
          <Chip mono tone="info" title={`ref ${r.source.ref}`}>
            {r.source.ref.length === 40 ? r.source.ref.slice(0, 7) : r.source.ref}
          </Chip>
          <Chip mono tone="info" icon={<GitCommitHorizontal />} title={r.source.sha}>
            {r.source.sha.slice(0, 7)}
          </Chip>
          <span className="min-w-0 truncate cm-mono text-2xs text-faint" title={`${r.source.repo}/${r.source.subdir}`}>
            {r.source.repo}
            {r.source.subdir ? `/${r.source.subdir}` : ""}
          </span>
          {r.source.browseUrl && (
            <a
              href={r.source.browseUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 text-2xs text-muted hover:text-primary [&_svg]:size-3"
            >
              view at this commit <ExternalLink />
            </a>
          )}
        </div>
        {r.description && <p className="mt-1.5 text-xs leading-relaxed text-secondary">{r.description}</p>}
        {r.readme && (
          <p className="mt-1 line-clamp-6 whitespace-pre-line text-2xs leading-relaxed text-muted" title={r.readme.file}>
            {r.readme.excerpt}
          </p>
        )}
      </div>

      {r.errors.length > 0 && (
        <div className="space-y-1">
          {r.errors.map((e) => (
            <InlineError key={e} message={e} />
          ))}
        </div>
      )}

      {/* -- warnings, mismatches first ------------------------------------ */}
      {problems > 0 && (
        <Section title="Warnings" count={problems}>
          {r.mismatches.undeclared.map((u) => (
            <Row key={`u-${u.capability}`} name={`uses ${u.capability}`} tone="danger">
              not declared — seen: {u.because.join(", ")}
            </Row>
          ))}
          {r.mismatches.unused.map((cap) => (
            <Row key={`n-${cap}`} name={`declares ${cap}`} tone="warn">
              nothing in the scanned code uses it
            </Row>
          ))}
          {r.warnings.map((w) => (
            <div key={w} className="flex items-start gap-1.5 py-0.5 text-2xs leading-relaxed text-warn [&_svg]:mt-0.5 [&_svg]:size-3 [&_svg]:shrink-0">
              <AlertTriangle />
              <span className="min-w-0">{w}</span>
            </div>
          ))}
        </Section>
      )}

      {/* -- capabilities -------------------------------------------------- */}
      <Section title="Capabilities" count={r.capabilities.length}>
        {r.capabilities.length === 0 ? (
          <p className="text-2xs text-faint">Declares none — it can use no gated part of the host API.</p>
        ) : (
          <div className="space-y-1">
            {r.capabilities.map((cap) => (
              <div key={cap.name} className="flex items-start gap-2">
                <Chip tone="accent" className="shrink-0">
                  {cap.name}
                </Chip>
                <span className="min-w-0 text-2xs leading-relaxed text-muted">
                  {cap.line}
                  {cap.used === false && <span className="text-warn"> Not seen in the code.</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {r.entries.server && <EntryChip side="server" entry={r.entries.server} />}
          {r.entries.client && <EntryChip side="client" entry={r.entries.client} />}
          {!r.entries.server && !r.entries.client && <span className="text-2xs text-faint">No server or browser module — contributions only.</span>}
        </div>
      </Section>

      {/* -- contributions ------------------------------------------------- */}
      {contributionCount > 0 && (
        <Section title="Contributions" count={contributionCount}>
          {c.modes.length > 0 && <Row name="modes">{c.modes.join(", ")}</Row>}
          {c.skills.length > 0 && <Row name="skills">{c.skills.join(", ")}</Row>}
          {c.instructions.length > 0 && <Row name="instructions">{c.instructions.join(", ")} — injected into every session</Row>}
          {c.personas.length > 0 && <Row name="personas">{c.personas.join(", ")}</Row>}
          {c.mcpServers.map((s) => (
            <Row key={`mcp-${s.name}`} name={`mcp:${s.name}`}>
              <code className="cm-mono !text-2xs break-all">{s.command ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? s.transport)}</code>
              {s.env?.length ? ` · sets ${s.env.join(", ")}` : ""}
            </Row>
          ))}
          {c.processes.map((p) => (
            <Row key={`proc-${p.id}`} name={`process:${p.id}`}>
              <code className="cm-mono !text-2xs break-all">{[p.command, ...(p.args ?? [])].join(" ")}</code>
              {p.ports?.length ? ` · port ${p.ports.join(", ")}` : ""}
              {p.autostart ? " · starts with the plugin" : " · on demand"}
              {p.singleton ? " · one per machine" : ""}
            </Row>
          ))}
        </Section>
      )}

      {/* -- secrets, oauth, settings -------------------------------------- */}
      {(r.secrets.length > 0 || r.oauth.length > 0 || fields.length > 0 || unsupported.length > 0) && (
        <Section title="Secrets, OAuth & settings">
          {r.secrets.length > 0 && (
            <div className="flex flex-wrap gap-1 py-0.5">
              {r.secrets.map((s) => (
                <Chip key={s} tone="warn" mono>
                  secret:{s}
                </Chip>
              ))}
            </div>
          )}
          {r.oauth.map((o) => (
            <Row key={`oauth-${o.name}`} name={`oauth:${o.name}`}>
              signs in to {o.provider}
              {o.scopes.length ? ` · scopes ${o.scopes.join(" ")}` : ""}
            </Row>
          ))}
          {fields.length > 0 && (
            <Row name="settings">
              {fields.map((f) => `${f.label} (${f.kind})`).join(", ")}
              {unsupported.length ? ` · not editable in the form: ${unsupported.join(", ")}` : ""}
            </Row>
          )}
        </Section>
      )}

      {/* -- hooks --------------------------------------------------------- */}
      <Section title="Hooks used" count={r.hooks.length}>
        {r.hooks.length === 0 && <p className="text-2xs text-faint">The scan found no host API use.</p>}
        <div className="space-y-1.5">
          {HOOK_GROUPS.map(({ kind, title }) => {
            const hooks = r.hooks.filter((h) => h.kind === kind);
            if (!hooks.length) return null;
            return (
              <div key={kind}>
                <div className="text-2xs font-medium text-secondary">{title}</div>
                {hooks.map((h) => (
                  <div key={h.label} className="flex flex-wrap items-baseline gap-x-2 pl-2 text-2xs leading-relaxed">
                    <span className={kind === "io" ? "cm-mono !text-2xs text-warn" : "cm-mono !text-2xs text-secondary"}>{h.label}</span>
                    <span className="cm-mono !text-2xs text-faint">
                      {h.file}:{h.line}
                      {h.count > 1 ? ` ×${h.count}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-2xs leading-relaxed text-faint">
          {r.scan.note}
          {r.scan.files.length ? ` Scanned: ${r.scan.files.join(", ")}.` : " No source files were found to scan."}
        </p>
      </Section>

      <InstallBar report={r} onInstalled={onInstalled} />
    </div>
  );
}

function EntryChip({ side, entry }: { side: "server" | "client"; entry: { path: string; present: boolean } }) {
  return (
    <Chip mono tone={entry.present ? "neutral" : "warn"} title={entry.present ? undefined : "not in the repository at this commit"}>
      {side === "server" ? "server (in-process)" : "client (in your browser)"}: {entry.path}
      {entry.present ? "" : " — missing"}
    </Chip>
  );
}

/* --------------------------------------------------------------- install */

function InstallBar({ report: r, onInstalled }: { report: PluginInspection; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inst = r.installed;
  const short = r.source.sha.slice(0, 7);

  const install = async (replace: boolean) => {
    if (replace && !confirm(`Replace the installed ${r.name ?? r.id} (v${inst?.version ?? "?"}) with v${r.version} at ${short}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.plugins.install(r.source.url, r.source.sha, replace);
      setDone(`${res.outcome === "replaced" ? "Updated" : "Installed"} ${res.id} at ${short}. Restart Dispatch to load it — plugins are not hot-reloaded.`);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  let action: ReactNode;
  if (done) {
    action = null;
  } else if (!r.installable) {
    action = (
      <Button variant="primary" size="sm" leftIcon={<Download />} disabled>
        Install
      </Button>
    );
  } else if (!inst) {
    action = (
      <Button variant="primary" size="sm" leftIcon={busy ? <Spinner size={12} /> : <Download />} disabled={busy} onClick={() => void install(false)}>
        {busy ? "Installing…" : "Install"}
      </Button>
    );
  } else if (inst.comparison === "same") {
    action = (
      <span className="inline-flex items-center gap-1.5 text-xs text-success [&_svg]:size-3.5">
        <CheckCircle2 /> Installed
      </span>
    );
  } else {
    const label = inst.comparison === "newer" ? `Update to ${r.version}` : `Replace with ${r.version}`;
    action = (
      <Button
        variant={inst.comparison === "newer" ? "primary" : "default"}
        size="sm"
        leftIcon={busy ? <Spinner size={12} /> : <Download />}
        disabled={busy}
        onClick={() => void install(true)}
      >
        {busy ? "Installing…" : label}
      </Button>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-line-soft pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 basis-48 text-2xs leading-relaxed text-muted">
          {!r.installable
            ? `Cannot install: ${r.refusal}.`
            : inst
              ? `Installed: v${inst.version ?? "?"}${inst.needsRestart ? " — restart Dispatch to load it" : inst.status ? ` (${inst.status})` : ""}.`
              : `Installs exactly commit ${short} — a later push to ${r.source.ref} is not picked up.`}
        </p>
        {action}
      </div>
      <InlineError message={error} />
      {done && (
        <p className="flex items-start gap-1.5 text-xs text-success [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
          <CheckCircle2 />
          <span className="min-w-0">{done}</span>
        </p>
      )}
    </div>
  );
}
