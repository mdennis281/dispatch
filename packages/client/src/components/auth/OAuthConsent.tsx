/**
 * The OAuth consent page — what a connector's `/oauth/authorize` lands on.
 *
 * Rendered by `App.tsx` inside `AuthGate` while `useOAuthConsent` holds a
 * nonce, INSTEAD of the shell: the person arrived here from another
 * application and the only question is whether that application may act as
 * them. Everything it shows comes from one authenticated fetch of the parked
 * request; the decision goes back with the session bearer, and the server
 * answers with the URL to send the browser to — Dispatch never builds a
 * redirect from anything the page itself holds.
 */
import { useEffect, useState } from "react";
import { Plug, ShieldCheck } from "lucide-react";
import type { OAuthDecisionResult, OAuthRequestView } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { InlineError } from "../sidebar/Modal.js";
import { sessionFetch, useAuth } from "../../stores/auth.js";
import { useOAuthConsent } from "../../stores/oauthConsent.js";
import { scopeHint } from "../../lib/scopeHints.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await sessionFetch(path, init);
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Request failed");
  return json as T;
}

export function OAuthConsent({ nonce }: { nonce: string }) {
  const user = useAuth((s) => s.user);
  const clear = useOAuthConsent((s) => s.clear);
  const [view, setView] = useState<OAuthRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<OAuthRequestView>(`/api/oauth/requests/${encodeURIComponent(nonce)}`)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await request<OAuthDecisionResult>(`/api/oauth/requests/${encodeURIComponent(nonce)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approve }),
      });
      setDone(approve ? "approved" : "denied");
      // A full navigation: the redirect URI is the connector's origin (or a
      // loopback listener, or a custom scheme), never this SPA.
      location.assign(result.redirectUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    // Its own scroll container: html/body are `overflow: hidden` for the shell,
    // so a connector asking for every scope pushed Approve below the fold with
    // no way to reach it. Flex + `min-h-full` rather than `place-items-center`,
    // which clips the TOP of a card taller than the viewport instead of scrolling.
    <div className="fixed inset-0 overflow-y-auto bg-app">
      <div className="flex min-h-full items-center justify-center p-5">
        <div
          className="w-full max-w-md rounded-xl border border-line-strong bg-overlay p-6 shadow-[var(--shadow-pop)]"
          data-testid="oauth-consent"
        >
          <div className="mb-5 flex items-start gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg text-accent [&_svg]:size-5">
              <ShieldCheck />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-primary">Authorize a connector</h1>
              <p className="mt-1 text-sm text-muted">
                {user ? `Signed in as ${user.displayName || user.username}.` : "Sign in to continue."}
              </p>
            </div>
          </div>

          {error && !view ? (
            <>
              <InlineError message={error} />
              <p className="mt-3 text-xs text-muted">
                Start again from the application that asked. Authorization requests expire after ten minutes.
              </p>
              <div className="mt-4 flex justify-end">
                <Button onClick={clear}>Back to Dispatch</Button>
              </div>
            </>
          ) : !view ? (
            <p className="text-sm text-muted">Loading the request…</p>
          ) : (
            <>
              <div className="rounded-md border border-line bg-inset/40 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-primary [&_svg]:size-4">
                  <Plug className="text-accent" />
                  {view.client.name}
                </p>
                <p className="mt-1 text-xs text-muted">
                  wants to act on your behalf in Dispatch. On approval, a code is sent back to{" "}
                  <span className="cm-mono text-secondary">{view.client.redirectHost}</span>.
                </p>
              </div>

              <p className="mb-1.5 mt-4 text-xs font-medium text-secondary">It is asking to</p>
              <ul className="space-y-1" aria-label="Requested scopes">
                {view.scopes.map((scope) => (
                  <li key={scope} className="flex items-start gap-2 rounded border border-line px-2 py-1.5 text-xs">
                    <Chip tone={scope.startsWith("tools:") ? "agent" : "info"} className="!text-2xs shrink-0">
                      {scope}
                    </Chip>
                    <span className="text-secondary">{scopeHint(scope)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-2xs leading-relaxed text-faint">
                The connector receives a token with exactly these scopes, valid for an hour and renewable for thirty days.
                It appears under Settings → Integrations, where you can revoke it at any time.
              </p>

              <InlineError message={error} />
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="danger" disabled={busy || done !== null} onClick={() => void decide(false)}>
                  Deny
                </Button>
                <Button variant="primary" disabled={busy || done !== null} onClick={() => void decide(true)}>
                  {done === "approved" ? "Approved — redirecting…" : busy ? "Please wait…" : "Approve"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
