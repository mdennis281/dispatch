import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, GitBranch, GitCommitHorizontal, Pin, Tag, Trash2, Unlink2 } from "lucide-react";
import type { PluginChange, PluginInfo, PluginUninstallPreview, PluginUninstallResult, PluginUpdateCheck } from "@dispatch/shared";
import { InlineError, Modal } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { api } from "../../../lib/api.js";

/**
 * Settings → Plugins, after install (#409): where a plugin came from, Check
 * for updates / Update, and Uninstall.
 *
 * Everything that decides anything is the server's — whether an update
 * exists, what it escalates, what Uninstall would remove — so this file only
 * lays it out. The update card leads with what the new version ASKS FOR that
 * the installed one did not, because that is the one thing an owner clicking
 * "Update" without reading would regret.
 */

/** A per-row update check: in flight, or its answer. */
export type CheckState = "checking" | PluginUpdateCheck;

const shortSha = (sha: string) => sha.slice(0, 7);

/** `github.com/o/r/sub` from a clone URL and subdir — what the row names as the source. */
function repoLabel(cloneUrl: string, subdir: string): string {
  const repo = cloneUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  return subdir ? `${repo}/${subdir}` : repo;
}

/* ---------------------------------------------------------------- source */

/** One line under the row's chips: where it came from, which commit, and what "update" would follow. */
export function PluginSourceLine({ plugin }: { plugin: PluginInfo }) {
  const s = plugin.source;
  let body: ReactNode;
  switch (plugin.origin) {
    case "builtin":
      // The header already carries the "built-in" chip; this line says what it means.
      body = <span className="text-2xs text-muted">Built-in, updates with Dispatch — nothing to install, update or remove.</span>;
      break;
    case "linked":
      body = (
        <>
          <Chip tone="agent">Linked</Chip>
          <span className="text-2xs text-muted">A working directory — edits load on restart; update it there.</span>
        </>
      );
      break;
    case "local":
      body = (
        <>
          <Chip tone="muted">Local copy</Chip>
          <span className="min-w-0 truncate cm-mono text-2xs text-faint" title={s?.type === "local" ? s.path : undefined}>
            {s?.type === "local" ? s.path : "copied from a path"}
          </span>
        </>
      );
      break;
    case "url":
      if (s?.type !== "git") return null;
      body = (
        <>
          <Chip
            mono
            tone="info"
            icon={s.refKind === "tag" ? <Tag /> : s.refKind === "sha" ? <Pin /> : <GitBranch />}
            title={s.refKind === "branch" ? `Follows branch ${s.ref}` : s.refKind === "tag" ? `Tag ${s.ref} — updates to newer version tags` : "Pinned to a commit"}
          >
            {s.refKind === "sha" ? "pinned" : s.ref}
          </Chip>
          <Chip mono tone="info" icon={<GitCommitHorizontal />} title={s.sha}>
            {shortSha(s.sha)}
          </Chip>
          <span className="min-w-0 truncate cm-mono text-2xs text-faint" title={s.url}>
            {repoLabel(s.cloneUrl, s.subdir)}
          </span>
          <span className="text-2xs text-faint">· installed {new Date(s.installedAt).toLocaleDateString()}</span>
        </>
      );
      break;
    default:
      body = (
        <span className="text-2xs text-faint" title="Installed by hand, or before Dispatch recorded where plugins come from">
          Source unknown
        </span>
      );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid={`plugin-source-${plugin.id}`}>
      {body}
    </div>
  );
}

/* ---------------------------------------------------------------- update */

function changeVerb(c: PluginChange): string {
  if (c.change === "removed") return "drops";
  if (c.change === "changed") return "changes";
  return "adds";
}

function ChangeRow({ change: c, tone }: { change: PluginChange; tone?: "danger" | "io" }) {
  const nameCls =
    tone === "danger" ? "text-danger" : tone === "io" ? "text-warn" : c.change === "removed" ? "text-faint line-through" : "text-secondary";
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-2xs leading-relaxed">
      <span className="w-12 shrink-0 text-faint">{changeVerb(c)}</span>
      <span className={`cm-mono !text-2xs ${nameCls}`}>{c.label}</span>
      {c.detail && <span className="min-w-0 basis-full pl-14 text-muted sm:basis-auto sm:pl-0">{c.detail}</span>}
    </div>
  );
}

function DiffHeading({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="mb-0.5 mt-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
      <span className="font-normal normal-case tracking-normal">· {count}</span>
    </div>
  );
}

/**
 * The answer to Check for updates, under the row. `available` is a card:
 * versions, ESCALATIONS (in danger red, first), the other declared changes,
 * then what moved in "hooks used", then the Update button.
 */
export function PluginUpdatePanel({
  plugin,
  check,
  onUpdated,
}: {
  plugin: PluginInfo;
  check: CheckState;
  onUpdated: (row: PluginInfo | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (check === "checking") {
    return (
      <p className="flex items-center gap-1.5 text-2xs text-muted">
        <Spinner size={11} /> Checking {plugin.source?.type === "git" ? repoLabel(plugin.source.cloneUrl, plugin.source.subdir) : "its source"}…
      </p>
    );
  }
  if (check.status === "error") return <InlineError message={`Could not check: ${check.message ?? "unknown error"}`} />;
  if (check.status !== "available") {
    const up = check.status === "up-to-date";
    return (
      <p className={`flex items-start gap-1.5 text-2xs leading-relaxed [&_svg]:mt-px [&_svg]:size-3 [&_svg]:shrink-0 ${up ? "text-success" : "text-muted"}`}>
        {up && <CheckCircle2 />}
        <span className="min-w-0">
          {up ? `Up to date — ${check.current?.ref ?? ""} @ ${check.current ? shortSha(check.current.sha) : ""}.` : ""}
          {check.message ? `${up ? " " : ""}${check.message}` : ""}
        </span>
      </p>
    );
  }

  const d = check.diff;
  const r = check.inspection;
  const t = check.target!;
  const installable = !!r?.installable && r.id === plugin.id;
  const hooks = d?.changes.filter((c) => c.kind === "hook") ?? [];
  const declared = d?.changes.filter((c) => c.kind !== "hook") ?? [];

  const update = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.plugins.update(plugin.id, t.sha);
      setDone(`Updated to ${t.version ? `v${t.version}` : shortSha(res.sha)} at ${shortSha(res.sha)}. Restart Dispatch to load it — plugins are not hot-reloaded.`);
      onUpdated(res.plugin);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1 rounded-md bg-inset/40 px-2.5 py-2" data-testid={`plugin-update-${plugin.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-semibold text-primary">
          Update available{d?.fromVersion || d?.toVersion ? `: v${d?.fromVersion ?? "?"} → v${d?.toVersion ?? "?"}` : ""}
        </span>
        <Chip mono tone="info" title={`ref ${t.ref}`}>
          {t.ref.length === 40 ? shortSha(t.ref) : t.ref}
        </Chip>
        <Chip mono tone="info" icon={<GitCommitHorizontal />} title={t.sha}>
          {check.current ? `${shortSha(check.current.sha)} → ` : ""}
          {shortSha(t.sha)}
        </Chip>
        {r?.source.browseUrl && (
          <a
            href={r.source.browseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-0.5 text-2xs text-muted hover:text-primary [&_svg]:size-3"
          >
            view <ExternalLink />
          </a>
        )}
      </div>
      {check.message && (
        <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-warn [&_svg]:mt-px [&_svg]:size-3 [&_svg]:shrink-0">
          <AlertTriangle />
          <span className="min-w-0">{check.message}</span>
        </p>
      )}

      {d && d.escalations.length > 0 && (
        <section data-testid="plugin-update-escalations">
          <DiffHeading count={d.escalations.length}>
            <span className="text-danger">Asks for more</span>
          </DiffHeading>
          {d.escalations.map((c) => (
            <ChangeRow key={`${c.kind}-${c.label}`} change={c} tone="danger" />
          ))}
        </section>
      )}
      {declared.length > 0 && (
        <section>
          <DiffHeading count={declared.length}>Other changes</DiffHeading>
          {declared.map((c) => (
            <ChangeRow key={`${c.kind}-${c.change}-${c.label}`} change={c} />
          ))}
        </section>
      )}
      {hooks.length > 0 && (
        <section>
          <DiffHeading count={hooks.length}>Hooks used</DiffHeading>
          {hooks.map((c) => (
            <ChangeRow key={`h-${c.change}-${c.hookKind}-${c.label}`} change={c} tone={c.hookKind === "io" && c.change === "added" ? "io" : undefined} />
          ))}
        </section>
      )}
      {d && !d.escalations.length && !declared.length && !hooks.length && (
        <p className="text-2xs text-faint">No change to what it declares or what the scan sees it hook into.</p>
      )}
      {r && r.warnings.length > 0 && (
        <details className="text-2xs text-muted">
          <summary className="cursor-pointer select-none text-warn">
            {r.warnings.length} warning{r.warnings.length === 1 ? "" : "s"} in the new version&apos;s report
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-relaxed">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-1.5">
        <p className="min-w-0 flex-1 basis-48 text-2xs leading-relaxed text-muted">
          {done
            ? ""
            : installable
              ? `Installs exactly ${shortSha(t.sha)}. Settings, kv, secrets and OAuth sign-ins are kept.`
              : `Cannot update: ${r?.refusal ?? (r?.id !== plugin.id ? "it is a different plugin" : "the new version is not installable")}.`}
        </p>
        {!done && (
          <Button
            variant={d?.escalations.length ? "danger" : "primary"}
            size="sm"
            leftIcon={busy ? <Spinner size={12} /> : <Download />}
            disabled={busy || !installable}
            onClick={() => void update()}
          >
            {busy ? "Updating…" : t.version ? `Update to v${t.version}` : "Update"}
          </Button>
        )}
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

/* ------------------------------------------------------------- uninstall */

function Bullet({ children, tone }: { children: ReactNode; tone?: "danger" | "muted" }) {
  return (
    <li className={`leading-relaxed ${tone === "danger" ? "text-danger" : tone === "muted" ? "text-muted" : "text-secondary"}`}>{children}</li>
  );
}

/** What the purge box covers, as a sentence fragment per item — empty when nothing is stored. */
function dataItems(p: PluginUninstallPreview): ReactNode[] {
  const out: ReactNode[] = [];
  if (p.data.settings) out.push("its settings and on/off toggle");
  if (p.data.kvKeys) out.push(`${p.data.kvKeys} stored value${p.data.kvKeys === 1 ? "" : "s"} (kv)`);
  if (p.data.secrets.length) {
    out.push(
      <>
        secret{p.data.secrets.length === 1 ? "" : "s"} <code className="cm-mono !text-2xs">{p.data.secrets.join(", ")}</code>
      </>,
    );
  }
  if (p.data.oauth.length) out.push(`OAuth sign-in${p.data.oauth.length === 1 ? "" : "s"}: ${p.data.oauth.join(", ")}`);
  return out;
}

/**
 * Uninstall confirmation. Loads `GET …/uninstall` so every line names a real
 * thing — the directory, the link and the directory it points at, the kv
 * count, the secret names — rather than "and its data".
 */
export function PluginUninstallDialog({
  plugin,
  open,
  onClose,
  onRemoved,
}: {
  plugin: PluginInfo;
  open: boolean;
  onClose: () => void;
  onRemoved: (result: PluginUninstallResult) => void;
}) {
  const [preview, setPreview] = useState<PluginUninstallPreview | null>(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPurge(false);
    setError(null);
    let live = true;
    api.plugins
      .uninstallPreview(plugin.id)
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, plugin.id]);

  const close = () => {
    if (!busy) onClose();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onRemoved(await api.plugins.uninstall(plugin.id, purge));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const link = preview?.removes === "link";
  const data = preview ? dataItems(preview) : [];

  return (
    <Modal
      open={open}
      onClose={close}
      width={460}
      icon={link ? <Unlink2 /> : <Trash2 />}
      title={`${link ? "Unlink" : "Uninstall"} ${plugin.name}`}
      description={plugin.id}
      footer={
        <>
          {error && (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          )}
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy || !preview}>
            {busy ? "Removing…" : link ? "Unlink" : purge ? "Uninstall and delete data" : "Uninstall"}
          </Button>
        </>
      }
    >
      {!preview ? (
        !error && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={13} /> Reading what it would remove…
          </div>
        )
      ) : (
        <div className="space-y-3 text-sm" data-testid="plugin-uninstall-preview">
          <div>
            <p className="mb-1 text-xs font-medium text-secondary">This removes</p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {link ? (
                <Bullet>
                  the link <code className="cm-mono !text-2xs break-all">{preview.dir}</code> — the directory it points at
                  {preview.linkTarget ? (
                    <>
                      {" "}
                      (<code className="cm-mono !text-2xs break-all">{preview.linkTarget}</code>)
                    </>
                  ) : null}{" "}
                  is left untouched
                </Bullet>
              ) : (
                <Bullet>
                  the plugin directory <code className="cm-mono !text-2xs break-all">{preview.dir}</code>
                </Bullet>
              )}
              {(preview.origin === "url" || preview.origin === "local") && <Bullet>its recorded source</Bullet>}
              {preview.active && (
                <Bullet>
                  its running code, now: routes, event listeners, processes and contributions stop
                  {preview.hasClient ? "; its browser half stays loaded in open tabs until they reload" : ""}
                </Bullet>
              )}
            </ul>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line-soft px-2.5 py-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={purge}
              disabled={busy}
              onChange={(e) => setPurge(e.target.checked)}
              data-testid="plugin-uninstall-purge"
            />
            <span className="min-w-0 text-xs leading-relaxed">
              <span className="font-medium text-primary">Also delete its data</span>
              {data.length ? (
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                  {data.map((item, i) => (
                    <Bullet key={i} tone={purge ? "danger" : "muted"}>
                      {item}
                    </Bullet>
                  ))}
                </ul>
              ) : (
                <span className="block text-muted">Nothing is stored for it.</span>
              )}
              {preview.data.sharedSecrets.map((s) => (
                <span key={s.name} className="mt-0.5 block text-2xs text-faint">
                  Keeps <code className="cm-mono !text-2xs">{s.name}</code> — {s.alsoUsedBy.join(", ")} also uses it.
                </span>
              ))}
              {(preview.data.kvKeys > 0 || preview.data.oauth.length > 0) && (
                <span className="mt-0.5 block text-2xs text-faint">
                  Stored values and sign-ins are this Dispatch instance&apos;s; another instance keeps its own.
                </span>
              )}
            </span>
          </label>
          {!purge && data.length > 0 && (
            <p className="text-2xs leading-relaxed text-muted">Left in place, so installing it again picks up where it left off.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
