import { useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { AuthSessionResponse, AuthStatus } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Field, InlineError, TextInput } from "../sidebar/Modal.js";
import { authPost, useAuth } from "../../stores/auth.js";
import { startLiveApp } from "../../lib/live.js";

function enter(session: AuthSessionResponse): void {
  useAuth.getState().applySession(session);
  const status = useAuth.getState().status;
  if (status) useAuth.getState().applyStatus({ ...status, enabled: true, configured: true, firstRunDismissed: true, user: session.user });
  startLiveApp();
}

function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-xl border border-line-strong bg-overlay p-6 shadow-[var(--shadow-pop)]">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-5"><ShieldCheck /></span>
        <div><h1 className="text-lg font-semibold text-primary">{title}</h1><p className="mt-1 text-sm text-muted">{description}</p></div>
      </div>
      {children}
    </div>
  );
}

function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = new URLSearchParams(location.search).get("setup");
  const [redeem, setRedeem] = useState(!!setup);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const path = redeem ? "/api/auth/setup/redeem" : "/api/auth/login";
      const session = await authPost<AuthSessionResponse>(path, redeem
        ? { code: setup, username, password }
        : { username, password, totp: totp || undefined });
      if (redeem) history.replaceState(null, "", location.pathname);
      enter(session);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function passkey() {
    setBusy(true); setError(null);
    try {
      const begin = await authPost<{ id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/passkeys/login/options");
      const response = await startAuthentication({ optionsJSON: begin.options });
      enter(await authPost<AuthSessionResponse>("/api/auth/passkeys/login/verify", { id: begin.id, response }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <Card title={redeem ? "Create your Dispatch account" : "Sign in to Dispatch"}
    description={redeem ? "This one-time invitation expires shortly." : "Your chats and configuration are shared across all accounts."}>
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Username" required><TextInput autoComplete="username webauthn" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="Password" required><TextInput type="password" autoComplete={redeem ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      {!redeem && <Field label="Authenticator code" hint="only if enabled"><TextInput inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>}
      <InlineError message={error} />
      <Button className="w-full" size="md" variant="primary" type="submit" disabled={busy}>{busy ? "Please wait…" : redeem ? "Create account" : "Sign in"}</Button>
      {!redeem && <Button className="w-full" size="md" type="button" onClick={() => void passkey()} disabled={busy} leftIcon={<KeyRound />}>Sign in with a passkey</Button>}
      {redeem && <Button className="w-full" variant="link" type="button" onClick={() => setRedeem(false)}>Back to sign in</Button>}
    </form>
  </Card>;
}

function FirstRun({ status }: { status: AuthStatus }) {
  const [setup, setSetup] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setBusy(true); setError(null);
    try {
      await authPost("/api/auth/first-run/dismiss");
      useAuth.getState().applyStatus({ ...status, firstRunDismissed: true });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { enter(await authPost<AuthSessionResponse>("/api/auth/bootstrap", { username, displayName, password, canonicalUrl })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <Card title="Protect Dispatch" description="Authentication is off by default. You can enable it now or configure it later in Settings.">
    {!setup ? <div className="space-y-3">
      <div className="rounded-lg border border-line bg-inset p-3 text-sm leading-relaxed text-secondary">Enable login before exposing Dispatch beyond this machine. The first account becomes the owner; all accounts see the same chats and settings.</div>
      <Button className="w-full" size="md" variant="primary" onClick={() => setSetup(true)}>Set up authentication</Button>
      <Button className="w-full" size="md" onClick={() => void dismiss()} disabled={busy}>Keep authentication off</Button>
    </div> : <form className="space-y-3" onSubmit={submit}>
      <Field label="Owner username" required><TextInput autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="Display name"><TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      <Field label="Password" hint="12 characters minimum" required><TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="Canonical URL" hint="passkey origin" required><TextInput value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} /></Field>
      <InlineError message={error} />
      <div className="flex gap-2"><Button type="button" onClick={() => setSetup(false)}>Back</Button><Button className="flex-1" size="md" variant="primary" type="submit" disabled={busy}>Create owner & enable</Button></div>
    </form>}
  </Card>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const ready = useAuth((state) => state.ready);
  const status = useAuth((state) => state.status);
  const user = useAuth((state) => state.user);
  if (!ready || !status) return <div className="grid h-screen place-items-center bg-app text-sm text-muted">Starting Dispatch…</div>;
  if (status.enabled && !user) return <div className="grid min-h-screen place-items-center bg-app p-5"><Login /></div>;
  return <>{children}{!status.enabled && !status.configured && !status.firstRunDismissed && <div role="dialog" aria-modal="true" aria-label="First-run authentication setup" className="fixed inset-0 z-[500] grid place-items-center bg-scrim p-5 backdrop-blur-sm"><FirstRun status={status} /></div>}</>;
}
