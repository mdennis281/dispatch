import { useEffect, useState, type FormEvent } from "react";
import { Copy, KeyRound, LogOut, Plus, Shield, Trash2 } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import type { AuthSecurityOverview, AuthSessionResponse, AuthSetupCode, AuthTotpSetup, AuthUserSummary } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Field, InlineError, TextInput } from "../sidebar/Modal.js";
import { SectionLabel } from "../ui/Panel.js";
import { SessionList } from "./SessionList.js";
import { TotpQr } from "./TotpQr.js";
import { authDelete, authPost, authPut, sessionFetch, useAuth } from "../../stores/auth.js";

async function get<T>(path: string): Promise<T> {
  const response = await sessionFetch(path);
  const json = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Unable to load security settings");
  return json as T;
}

function SetupAuth() {
  const status = useAuth((s) => s.status)!;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(status.canonicalUrl ?? location.origin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const endpoint = status.configured ? "/api/auth/enable" : "/api/auth/bootstrap";
      const session = await authPost<AuthSessionResponse>(endpoint, status.configured
        ? { username, password }
        : { username, password, canonicalUrl });
      useAuth.getState().applySession(session);
      useAuth.getState().applyStatus({ ...status, enabled: true, configured: true, firstRunDismissed: true, user: session.user });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="rounded-lg border border-line bg-inset/40 p-3">
    <p className="mb-3 text-xs leading-relaxed text-muted">{status.configured ? "Authenticate as the existing owner to turn login back on." : "Create the bootstrap owner. Existing installs remain open until this form is completed."}</p>
    <form className="space-y-2" onSubmit={submit}>
      <Field label="Owner username"><TextInput value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="Password" hint="12 characters minimum"><TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      {!status.configured && <Field label="Canonical URL" hint="localhost or HTTPS"><TextInput value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} /></Field>}
      <InlineError message={error} />
      <Button type="submit" variant="primary" disabled={busy}>{status.configured ? "Enable authentication" : "Create owner & enable"}</Button>
    </form>
  </div>;
}

export function AuthSettings() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const [security, setSecurity] = useState<AuthSecurityOverview | null>(null);
  const [users, setUsers] = useState<AuthUserSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setupLink, setSetupLink] = useState<AuthSetupCode | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totp, setTotp] = useState<AuthTotpSetup | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [resetTarget, setResetTarget] = useState<AuthUserSummary | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(status?.canonicalUrl ?? location.origin);
  const [rpId, setRpId] = useState(status?.rpId ?? location.hostname);

  // Every async button routes through this: a handler that throws on its own
  // leaves the click looking like it did nothing at all, which is exactly how a
  // rejected request reads to the user.
  // Generic in its arguments so a list child can hand back the row it acted on
  // (revoking session X) without every such callback re-implementing the catch.
  const guard = <A extends unknown[]>(action: (...args: A) => Promise<void>) => async (...args: A) => {
    setError(null);
    try { await action(...args); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const reload = async () => {
    if (!status?.enabled || !user) return;
    const next = await get<AuthSecurityOverview>("/api/auth/security");
    setSecurity(next);
    if (user.owner) setUsers(await get<AuthUserSummary[]>("/api/auth/users"));
  };
  useEffect(() => { void guard(reload)(); }, [status?.enabled, user?.id]);
  useEffect(() => {
    setCanonicalUrl(status?.canonicalUrl ?? location.origin);
    setRpId(status?.rpId ?? location.hostname);
  }, [status?.canonicalUrl, status?.rpId]);

  if (!status) return null;
  return <div>
    <SectionLabel className="mb-1.5 px-0"><span className="inline-flex items-center gap-1.5 [&_svg]:size-3"><Shield /> Authentication</span></SectionLabel>
    {!status.enabled ? <SetupAuth /> : <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-line bg-inset/40 p-3">
        <div><p className="text-sm font-medium text-primary">Signed in as {user?.displayName}</p><p className="text-xs text-muted">{user?.username}{user?.owner ? " · bootstrap owner" : ""}</p></div>
        <Button leftIcon={<LogOut />} onClick={guard(async () => {
          await authPost("/api/auth/logout"); useAuth.getState().clear(); location.reload();
        })}>Sign out</Button>
      </div>

      <div className="rounded-lg border border-line p-3">
        <p className="mb-2 text-xs font-medium text-secondary">Change password</p>
        <div className="grid grid-cols-2 gap-2"><TextInput type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /><TextInput type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
        <Button className="mt-2" onClick={guard(async () => { await authPost("/api/auth/password", { currentPassword, password: newPassword }); setCurrentPassword(""); setNewPassword(""); })}>Update password</Button>
      </div>

      {user?.owner && <div className="rounded-lg border border-line p-3">
        <p className="text-xs font-medium text-secondary">Passkey origin</p>
        <p className="mt-1 text-2xs leading-relaxed text-warning">Changing the canonical URL or RP ID can make existing passkeys unusable. Users may need to re-enroll them from the new hostname.</p>
        <form className="mt-2 grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          void guard(async () => {
            const updated = await authPut<{ canonicalUrl: string; rpId: string }>("/api/auth/webauthn", { canonicalUrl, rpId });
            setCanonicalUrl(updated.canonicalUrl); setRpId(updated.rpId);
            useAuth.getState().applyStatus({ ...status, ...updated });
          })();
        }}>
          <Field label="Canonical URL" hint="localhost or HTTPS"><TextInput value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} /></Field>
          <Field label="RP ID" hint="hostname or parent domain"><TextInput value={rpId} onChange={(e) => setRpId(e.target.value)} /></Field>
          <Button className="justify-self-start" type="submit">Update passkey origin</Button>
        </form>
      </div>}

      <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between"><div><p className="text-xs font-medium text-secondary">Passkeys</p><p className="text-2xs text-faint">Passwordless login on supported devices</p></div><Button leftIcon={<Plus />} onClick={guard(async () => {
          const options = await authPost<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkeys/register/options");
          const response = await startRegistration({ optionsJSON: options });
          await authPost("/api/auth/passkeys/register/verify", { response, name: "Passkey" }); await reload();
        })}>Add passkey</Button></div>
        <div className="mt-2 space-y-1">{security?.passkeys.map((passkey) => <div key={passkey.id} className="flex items-center justify-between rounded bg-inset px-2 py-1.5 text-xs"><span className="inline-flex items-center gap-1.5"><KeyRound className="size-3" />{passkey.name}</span><Button variant="danger" leftIcon={<Trash2 />} onClick={guard(async () => { await authDelete(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`); await reload(); })}>Remove</Button></div>)}</div>
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between"><div><p className="text-xs font-medium text-secondary">Authenticator app (TOTP)</p><p className="text-2xs text-faint">Optional second factor for password login</p></div>{!security?.user.totpEnabled && !totp && <Button onClick={guard(async () => setTotp(await authPost<AuthTotpSetup>("/api/auth/totp/begin")))}>Set up</Button>}</div>
        {totp && <div className="mt-2 flex gap-3 rounded bg-inset p-2">
          <TotpQr uri={totp.uri} className="size-32 shrink-0 rounded" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-2xs leading-relaxed text-muted">Scan with your authenticator app, or enter this key by hand:</p>
            <p className="break-all font-mono text-2xs text-secondary">{totp.secret}</p>
            <TextInput inputMode="numeric" placeholder="6-digit code" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            <Button onClick={guard(async () => { await authPost("/api/auth/totp/confirm", { code: totpCode }); setTotp(null); setTotpCode(""); await reload(); })}>Confirm</Button>
          </div>
        </div>}
        {security?.user.totpEnabled && <Button className="mt-2" variant="danger" onClick={guard(async () => { await authDelete("/api/auth/totp", { password: currentPassword }); await reload(); })}>Disable using current password</Button>}
      </div>

      {security && <SessionList
        security={security}
        onRevoke={guard(async (id: string) => { await authDelete(`/api/auth/sessions/${id}`); await reload(); })}
        onToggleLookup={guard(async (enabled: boolean) => { await authPut("/api/auth/ip-lookup", { enabled }); await reload(); })}
      />}

      {user?.owner && <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between"><div><p className="text-xs font-medium text-secondary">Accounts</p><p className="text-2xs text-faint">Every account sees the same chats and configuration.</p></div><Button leftIcon={<Plus />} onClick={guard(async () => setSetupLink(await authPost("/api/auth/setup-codes")))}>Invite user</Button></div>
        {setupLink && <div className="mt-2 flex gap-2"><TextInput readOnly value={setupLink.url} /><Button leftIcon={<Copy />} onClick={() => void navigator.clipboard.writeText(setupLink.url)}>Copy</Button></div>}
        <div className="mt-2 space-y-1">{users.map((account) => <div key={account.id} className="flex items-center justify-between rounded bg-inset px-2 py-1.5 text-xs"><span>{account.displayName} <span className="text-faint">@{account.username}{account.owner ? " · owner" : ""}</span></span>{!account.owner && <span className="flex gap-1"><Button onClick={() => { setResetTarget(account); setResetPassword(""); }}>Reset password</Button><Button variant="danger" leftIcon={<Trash2 />} onClick={guard(async () => { if (!confirm(`Delete @${account.username}? Their active sessions will be revoked.`)) return; await authDelete(`/api/auth/users/${account.id}`); await reload(); })}>Delete</Button></span>}</div>)}</div>
        {resetTarget && <form className="mt-2 rounded bg-inset p-2" onSubmit={(event) => {
          event.preventDefault();
          void guard(async () => {
            await authPost(`/api/auth/users/${resetTarget.id}/reset`, { password: resetPassword });
            setResetTarget(null); setResetPassword(""); await reload();
          })();
        }}>
          <Field label={`New password for @${resetTarget.username}`} hint="12 characters minimum"><TextInput autoComplete="new-password" type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></Field>
          <div className="mt-2 flex gap-2"><Button type="button" onClick={() => setResetTarget(null)}>Cancel</Button><Button type="submit" variant="primary">Reset password</Button></div>
        </form>}
      </div>}

      {user?.owner && <Button variant="danger" onClick={guard(async () => {
        if (!confirm("Turn authentication off and revoke every session? Accounts and credentials will be preserved.")) return;
        await authPost("/api/auth/disable"); useAuth.getState().clear(); useAuth.getState().applyStatus({ ...status, enabled: false, user: null });
      })}>Turn authentication off</Button>}
      <InlineError message={error} />
    </div>}
  </div>;
}
