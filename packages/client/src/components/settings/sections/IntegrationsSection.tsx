/**
 * Settings → Integrations. Blocks for the ways something that is not a browser
 * reaches this instance: TOKENS (this file's `TokensBlock`) for calls in, and
 * WEBHOOKS (`WebhooksBlock.tsx`) for signed POSTs out.
 *
 * Nothing here lives in the app-settings draft — a token is minted and revoked
 * the moment you click, like a session — so the section takes no pane props
 * and ignores the save bar. Every request goes through `sessionFetch`: the
 * token routes sit behind the auth gate and a bare fetch would 401.
 *
 * THE VALUE IS SHOWN ONCE. The create response is the only copy that will ever
 * exist; the list below it is hashes-only on the server and shows names. So
 * the reveal is a deliberate state (`fresh`) that survives until dismissed,
 * with Copy right beside it, and the explanation says so in words.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  INTEGRATION_FIXED_SCOPES,
  INTEGRATION_SCOPES,
  MANAGER_CATEGORIES,
  toolScope,
  type IntegrationScope,
  type IntegrationTokenCreated,
  type IntegrationTokenSummary,
} from "@dispatch/shared";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { Select } from "../../ui/Select.js";
import { Field, InlineError, TextInput } from "../../sidebar/Modal.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Switch } from "../../ui/Switch.js";
import { sessionFetch, useAuth } from "../../../stores/auth.js";
import { useRealProjects } from "../../../stores/projects.js";
import { relTime } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import { WebhooksBlock } from "./WebhooksBlock.js";

/* ------------------------------------------------------------------ api */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await sessionFetch(path, init);
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Request failed");
  return json as T;
}

const listTokens = () => request<{ tokens: IntegrationTokenSummary[] }>("/api/auth/tokens");
const revokeToken = (id: string) => request<{ ok: true }>(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
const createToken = (body: { name: string; scopes: string[]; projectIds?: string[]; expiresAt?: number }) =>
  request<IntegrationTokenCreated>("/api/auth/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* ---------------------------------------------------------------- scopes */

/** What each fixed scope means, in the words the checkbox shows. */
const SCOPE_HINT: Record<(typeof INTEGRATION_FIXED_SCOPES)[number], string> = {
  "chats:read": "List chats and read transcripts",
  "chats:write": "Send messages into chats",
  "attention:read": "See what is waiting on a human",
  "attention:answer": "Answer question cards",
  "memory:read": "Read project memory",
  "memory:write": "Write project memory",
  "projects:read": "List projects",
  "webhooks:manage": "Manage its own webhook subscriptions",
};

type Expiry = "never" | "7d" | "30d" | "90d" | "365d";
const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "365d", label: "1 year" },
];
const DAY_MS = 86_400_000;
function expiresAtOf(e: Expiry): number | undefined {
  if (e === "never") return undefined;
  return Date.now() + Number.parseInt(e, 10) * DAY_MS;
}

/** Scope chips on a row: short, with `tools:` collapsed to the category. */
function ScopeChips({ scopes }: { scopes: IntegrationScope[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Chip key={s} tone={s.startsWith("tools:") ? "agent" : "info"} className="!text-2xs">
          {s}
        </Chip>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------ the reveal */

function FreshToken({ created, onDone }: { created: IntegrationTokenCreated; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-accent-line bg-accent-ghost/40 p-3">
      <p className="text-xs font-medium text-primary">
        Token for <span className="font-semibold">{created.summary.name}</span> — copy it now
      </p>
      <p className="mt-0.5 text-2xs leading-relaxed text-muted">
        This is the only time it will be shown. Dispatch keeps a hash, not the value; lose it and
        you mint another.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <TextInput mono readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} />
        <Button
          leftIcon={copied ? <Check /> : <Copy />}
          onClick={() => {
            void navigator.clipboard?.writeText(created.token).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2_000);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- create */

function CreateTokenForm({ onCreated, onCancel }: { onCreated: (t: IntegrationTokenCreated) => void; onCancel: () => void }) {
  const projects = useRealProjects();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<IntegrationScope>>(new Set(["chats:read"]));
  const [allProjects, setAllProjects] = useState(true);
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<Expiry>("90d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (scope: IntegrationScope, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createToken({
        name,
        scopes: INTEGRATION_SCOPES.filter((s) => scopes.has(s)),
        ...(allProjects ? {} : { projectIds: [...projectIds] }),
        ...(expiresAtOf(expiry) !== undefined ? { expiresAt: expiresAtOf(expiry) } : {}),
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 rounded-md border border-line bg-inset/40 p-3" onSubmit={submit}>
      <Field label="Name" hint="shown on every message it sends">
        <TextInput
          autoFocus
          value={name}
          placeholder="grok-bot"
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div>
        <p className="mb-1 text-xs font-medium text-secondary">Scopes</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {INTEGRATION_FIXED_SCOPES.map((scope) => (
            <label
              key={scope}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs",
                scopes.has(scope) ? "border-accent-line bg-accent-ghost/30" : "border-line",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={scopes.has(scope)}
                onChange={(e) => toggle(scope, e.target.checked)}
              />
              <span className="min-w-0">
                <span className="cm-mono !text-2xs text-primary">{scope}</span>
                <span className="block text-2xs text-faint">{SCOPE_HINT[scope]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mb-1 mt-2 text-xs font-medium text-secondary">MCP tool categories</p>
        <p className="mb-1 text-2xs leading-relaxed text-faint">
          Each unlocks one server on <span className="cm-mono">/api/mcp/integration/&lt;category&gt;</span>, serving
          only the tools that make sense with no chat of its own — categories made of session,
          shell or PR tools have nothing to offer.
        </p>
        <div className="flex flex-wrap gap-1">
          {MANAGER_CATEGORIES.map((category) => {
            const scope = toolScope(category);
            const on = scopes.has(scope);
            // The kit's toggle: the pressed look reads off `aria-pressed`, so
            // the accessible state and the visible one cannot drift.
            // `type="button"` is load-bearing: inside a <form> a button defaults
            // to submit, and the first pill clicked minted the token with
            // whatever scopes happened to be ticked.
            return (
              <Button
                key={scope}
                type="button"
                variant="toggle"
                size="sm"
                aria-pressed={on}
                onClick={() => toggle(scope, !on)}
                className="cm-mono !text-2xs"
              >
                {scope}
              </Button>
            );
          })}
        </div>
      </div>

      <div>
        <Switch
          checked={allProjects}
          onChange={setAllProjects}
          label={allProjects ? "Every project" : "Only these projects"}
        />
        {!allProjects && (
          <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={projectIds.has(p.id)}
                  onChange={(e) =>
                    setProjectIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    })
                  }
                />
                <span className="truncate">{p.name}</span>
              </label>
            ))}
            {projects.length === 0 && <span className="text-2xs text-faint">No projects yet.</span>}
          </div>
        )}
        <p className="mt-1 text-2xs leading-relaxed text-faint">
          Memory and issue tools on the MCP mount need exactly one project to act on; a token for
          those should name just one.
        </p>
      </div>

      <Field label="Expires">
        <Select options={EXPIRY_OPTIONS} value={expiry} onChange={setExpiry} />
      </Field>

      <InlineError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || scopes.size === 0}>
          {busy ? "Creating…" : "Create token"}
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- list */

function tokenState(t: IntegrationTokenSummary, now: number): "active" | "expired" | "revoked" {
  if (t.revokedAt !== undefined) return "revoked";
  if (t.expiresAt !== undefined && t.expiresAt <= now) return "expired";
  return "active";
}

function TokenRow({ token, onRevoke }: { token: IntegrationTokenSummary; onRevoke: () => void }) {
  const now = Date.now();
  const state = tokenState(token, now);
  const dead = state !== "active";
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded bg-inset px-2.5 py-2", dead && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary [&_svg]:size-3">
            <KeyRound />
            {token.name}
          </span>
          {token.clientId && <Chip tone="muted">oauth</Chip>}
          {state === "revoked" && <Chip tone="danger">revoked</Chip>}
          {state === "expired" && <Chip tone="warn">expired</Chip>}
        </div>
        <div className="mt-1">
          <ScopeChips scopes={token.scopes} />
        </div>
        <p className="mt-1 text-2xs text-faint">
          {token.projectIds?.length ? `${token.projectIds.length} project${token.projectIds.length === 1 ? "" : "s"} · ` : "every project · "}
          created {relTime(token.createdAt, now)} ·{" "}
          {token.lastUsedAt ? `last used ${relTime(token.lastUsedAt, now)}` : "never used"}
          {token.expiresAt !== undefined && state === "active"
            ? ` · expires ${new Date(token.expiresAt).toLocaleDateString()}`
            : ""}
        </p>
      </div>
      {!dead && (
        <Button variant="danger" size="sm" leftIcon={<Trash2 />} onClick={onRevoke}>
          Revoke
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- block */

export function TokensBlock() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const [tokens, setTokens] = useState<IntegrationTokenSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<IntegrationTokenCreated | null>(null);
  const [showDead, setShowDead] = useState(false);

  const enabled = status?.enabled === true;
  const owner = user?.owner === true;

  const reload = useCallback(async () => {
    if (!enabled || !owner) return;
    setError(null);
    try {
      setTokens((await listTokens()).tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [enabled, owner]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = (tokens ?? []).filter((t) => showDead || tokenState(t, Date.now()) === "active");
  const hidden = (tokens ?? []).length - visible.length;

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-secondary">Tokens</p>
          <p className="text-2xs text-faint">
            Long-lived bearer tokens for a bot or script: <span className="cm-mono">Authorization: Bearer dsp_…</span>
          </p>
        </div>
        {enabled && owner && !creating && (
          <Button leftIcon={<Plus />} onClick={() => { setFresh(null); setCreating(true); }}>
            New token
          </Button>
        )}
      </div>

      {!enabled ? (
        <p className="mt-2 rounded-md border border-line bg-inset/40 px-2.5 py-2 text-xs leading-relaxed text-muted">
          Turn authentication on first. An open install has nothing to scope — every caller already
          has everything — so there is nothing a token could grant.
        </p>
      ) : !owner ? (
        <p className="mt-2 text-xs text-muted">Only the bootstrap owner can manage tokens.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {fresh && <FreshToken created={fresh} onDone={() => setFresh(null)} />}
          {creating && (
            <CreateTokenForm
              onCancel={() => setCreating(false)}
              onCreated={(t) => {
                setCreating(false);
                setFresh(t);
                void reload();
              }}
            />
          )}
          {tokens === null && !error ? (
            <p className="text-xs text-faint">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="text-xs text-faint">No active tokens.</p>
          ) : (
            <div className="space-y-1">
              {visible.map((t) => (
                <TokenRow
                  key={t.id}
                  token={t}
                  onRevoke={() => {
                    if (!confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`)) return;
                    void revokeToken(t.id).then(reload, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                />
              ))}
            </div>
          )}
          {hidden > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowDead(true)}>
              Show {hidden} revoked or expired
            </Button>
          )}
          {showDead && hidden === 0 && tokens && tokens.length > visible.length && null}
          <InlineError message={error} />
        </div>
      )}
    </div>
  );
}

export function IntegrationsSection() {
  return (
    <div className="space-y-3">
      <SectionLabel className="mb-1.5 px-0">
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
          <KeyRound /> Integrations
        </span>
      </SectionLabel>
      <TokensBlock />
      <WebhooksBlock />
    </div>
  );
}
