/**
 * Settings → Integrations → Connected apps: the OAuth grants, one per
 * connector the owner approved on the consent page. Sits beside the Tokens
 * block because a grant's current access token IS a row there (the `oauth`
 * chip); this block is where the connector itself — its refresh token and
 * every future hour of access — is revoked.
 */
import { useCallback, useEffect, useState } from "react";
import { Plug, Trash2 } from "lucide-react";
import type { OAuthGrantSummary } from "@dispatch/shared";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { InlineError } from "../../sidebar/Modal.js";
import { sessionFetch, useAuth } from "../../../stores/auth.js";
import { relTime } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await sessionFetch(path, init);
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Request failed");
  return json as T;
}

const listGrants = () => request<{ grants: OAuthGrantSummary[] }>("/api/auth/oauth/grants");
const revokeGrant = (id: string) => request<{ ok: true }>(`/api/auth/oauth/grants/${encodeURIComponent(id)}`, { method: "DELETE" });

function grantState(g: OAuthGrantSummary, now: number): "active" | "expired" | "revoked" {
  if (g.revokedAt !== undefined) return "revoked";
  if (g.refreshExpiresAt === undefined || g.refreshExpiresAt <= now) return "expired";
  return "active";
}

function GrantRow({ grant, onRevoke }: { grant: OAuthGrantSummary; onRevoke: () => void }) {
  const now = Date.now();
  const state = grantState(grant, now);
  const dead = state !== "active";
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded bg-inset px-2.5 py-2", dead && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary [&_svg]:size-3">
            <Plug />
            {grant.clientName}
          </span>
          {state === "revoked" && <Chip tone="danger">revoked</Chip>}
          {state === "expired" && <Chip tone="warn">expired</Chip>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {grant.scopes.map((s) => (
            <Chip key={s} tone={s.startsWith("tools:") ? "agent" : "info"} className="!text-2xs">
              {s}
            </Chip>
          ))}
        </div>
        <p className="mt-1 text-2xs text-faint">
          approved {relTime(grant.createdAt, now)}
          {grant.lastRefreshedAt ? ` · renewed ${relTime(grant.lastRefreshedAt, now)}` : ""}
          {state === "active" && grant.refreshExpiresAt !== undefined
            ? ` · renewable until ${new Date(grant.refreshExpiresAt).toLocaleDateString()}`
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

export function OAuthGrantsBlock() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const [grants, setGrants] = useState<OAuthGrantSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDead, setShowDead] = useState(false);

  const enabled = status?.enabled === true;
  const owner = user?.owner === true;

  const reload = useCallback(async () => {
    if (!enabled || !owner) return;
    setError(null);
    try {
      setGrants((await listGrants()).grants);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [enabled, owner]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = (grants ?? []).filter((g) => showDead || grantState(g, Date.now()) === "active");
  const hidden = (grants ?? []).length - visible.length;

  return (
    <div className="rounded-lg border border-line p-3" data-testid="oauth-grants">
      <div>
        <p className="text-xs font-medium text-secondary">Connected apps</p>
        <p className="text-2xs text-faint">
          Remote MCP connectors that signed in through OAuth. Point one at{" "}
          <span className="cm-mono">{status?.canonicalUrl ? `${status.canonicalUrl}/api/mcp/integration/<category>` : "/api/mcp/integration/<category>"}</span>; it
          discovers the rest.
        </p>
      </div>

      {!enabled ? (
        <p className="mt-2 text-xs text-muted">Turn authentication on first; connectors sign in as you.</p>
      ) : !owner ? (
        <p className="mt-2 text-xs text-muted">Only the bootstrap owner can authorize connectors.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {grants === null && !error ? (
            <p className="text-xs text-faint">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="text-xs text-faint">No connected apps.</p>
          ) : (
            <div className="space-y-1">
              {visible.map((g) => (
                <GrantRow
                  key={g.id}
                  grant={g}
                  onRevoke={() => {
                    if (!confirm(`Disconnect "${g.clientName}"? It will have to sign in again.`)) return;
                    void revokeGrant(g.id).then(reload, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                />
              ))}
            </div>
          )}
          {hidden > 0 && !showDead && (
            <Button size="sm" variant="ghost" onClick={() => setShowDead(true)}>
              Show {hidden} revoked or expired
            </Button>
          )}
          <InlineError message={error} />
        </div>
      )}
    </div>
  );
}
