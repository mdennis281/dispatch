/**
 * Active sessions — the list, and the per-session detail modal behind it.
 *
 * The list answers "is anything here not me?" at a glance: device, last seen,
 * and where it is on the network. Everything else — the raw user-agent, both
 * expiries, the geolocation provider's answer in full — lives one click deeper,
 * because a row that shows all of it shows none of it.
 */
import { useState } from "react";
import { Bot, Globe, Laptop, MapPin, Smartphone, Tablet, Trash2 } from "lucide-react";
import { describeSessionClient, type AuthSecurityOverview, type AuthSessionSummary, type SessionNetwork } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Switch } from "../ui/Switch.js";
import { Modal } from "../sidebar/Modal.js";
import { relTime, untilShort } from "../../lib/format.js";

const SCOPE_LABEL: Record<SessionNetwork["scope"], string> = {
  loopback: "This machine",
  private: "Local network",
  public: "Internet",
  unknown: "Unknown network",
};

function DeviceIcon({ session }: { session: AuthSessionSummary }) {
  const Icon = session.client.bot ? Bot
    : session.client.device === "mobile" ? Smartphone
    : session.client.device === "tablet" ? Tablet
    : Laptop;
  return <Icon className="size-3.5 shrink-0 text-faint" />;
}

/** 🇺🇸 from "US" — regional indicators, so no flag assets ship for this. */
function flag(countryCode: string | undefined): string {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(...[...countryCode.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

function place(network: SessionNetwork): string | null {
  const parts = [network.city, network.region, network.countryCode ?? network.country].filter(Boolean);
  return parts.length ? `${flag(network.countryCode)} ${parts.join(", ")}`.trim() : null;
}

/** The one-line network summary a row shows: the most specific thing we know. */
function networkLine(session: AuthSessionSummary): string {
  const located = place(session.network);
  const ip = session.ip ?? "unknown IP";
  if (located) return `${ip} · ${located}${session.network.isp ? ` · ${session.network.isp}` : ""}`;
  return `${ip} · ${SCOPE_LABEL[session.network.scope]}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return <div className="flex gap-3 py-1 text-xs">
    <span className="w-28 shrink-0 text-faint">{label}</span>
    <span className="min-w-0 flex-1 break-words text-secondary">{value}</span>
  </div>;
}

function when(ts: number): string {
  return `${relTime(ts)} · ${new Date(ts).toLocaleString()}`;
}

function SessionDetail({ session, onClose, onRevoke }: {
  session: AuthSessionSummary;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const { client, network } = session;
  return <Modal
    open
    onClose={onClose}
    width={520}
    icon={<DeviceIcon session={session} />}
    title={describeSessionClient(client)}
    description={session.current ? "This device — the session you are reading this in" : "Signed in elsewhere"}
    footer={<Button
      variant="danger"
      leftIcon={<Trash2 />}
      disabled={session.current}
      onClick={onRevoke}
    >{session.current ? "Sign out from the account panel" : "Revoke this session"}</Button>}
  >
    <div className="space-y-4">
      <section>
        <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-faint">Client</p>
        <Row label="Browser" value={client.browser ?? "Unrecognised"} />
        <Row label="Operating system" value={client.os ?? "Unrecognised"} />
        <Row label="Device" value={client.bot ? "Automation / non-browser client" : client.device} />
        <Row label="Engine" value={client.engine} />
        {/* Everything above is inferred from this string; show it so a wrong
            inference is diagnosable rather than just puzzling. */}
        <Row label="User agent" value={<span className="cm-mono text-2xs text-muted">{session.userAgent || "(none sent)"}</span>} />
      </section>

      <section>
        <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-faint">Network</p>
        <Row label="IP address" value={<span className="cm-mono">{session.ip ?? "unknown"}</span>} />
        <Row label="Scope" value={SCOPE_LABEL[network.scope]} />
        <Row label="ISP" value={network.isp} />
        <Row label="Organisation" value={network.org} />
        <Row label="Location" value={place(network)} />
        <Row label="Timezone" value={network.timezone} />
        {network.scope === "public" && !network.lookedUpAt && <Row label="Lookup" value="Off — enable IP lookup to resolve ISP and location." />}
        {network.error && <Row label="Lookup" value={<span className="text-warning">Failed: {network.error}</span>} />}
        {network.scope !== "public" && network.scope !== "unknown" && <Row label="Lookup" value="Not applicable — private addresses are never sent off this machine." />}
      </section>

      <section>
        <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-faint">Timeline</p>
        <Row label="Last seen" value={when(session.lastSeenAt)} />
        <Row label="Last sign-in refresh" value={when(session.lastUsedAt)} />
        <Row label="Signed in" value={when(session.createdAt)} />
        <Row label="Idle expiry" value={`in ${untilShort(session.expiresAt)} · ${new Date(session.expiresAt).toLocaleString()}`} />
        <Row label="Hard expiry" value={`in ${untilShort(session.absoluteExpiresAt)} · ${new Date(session.absoluteExpiresAt).toLocaleString()}`} />
      </section>
    </div>
  </Modal>;
}

export function SessionList({ security, onRevoke, onToggleLookup }: {
  security: AuthSecurityOverview;
  onRevoke: (id: string) => Promise<void>;
  onToggleLookup: (enabled: boolean) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = security.sessions.find((s) => s.id === openId) ?? null;
  const anyPublic = security.sessions.some((s) => s.network.scope === "public");

  return <div className="rounded-lg border border-line p-3">
    <p className="mb-2 text-xs font-medium text-secondary">Active sessions</p>
    <div className="space-y-1">
      {security.sessions.map((session) => <div key={session.id} className="flex items-center gap-2 rounded bg-inset px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpenId(session.id)}
        >
          <DeviceIcon session={session} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5 text-xs">
              <span className="truncate text-secondary">{describeSessionClient(session.client)}</span>
              {session.current && <span className="shrink-0 text-2xs text-accent">This device</span>}
            </span>
            <span className="mt-px flex items-center gap-1 truncate text-2xs text-faint">
              {session.network.scope === "public" ? <Globe className="size-2.5 shrink-0" /> : <MapPin className="size-2.5 shrink-0" />}
              <span className="truncate">{relTime(session.lastSeenAt)} · {networkLine(session)}</span>
            </span>
          </span>
        </button>
        <Button variant="danger" disabled={session.current} onClick={() => void onRevoke(session.id)}>Revoke</Button>
      </div>)}
    </div>

    <div className="mt-2.5 cm-hairline-t pt-2.5">
      <Switch
        checked={security.ipLookup}
        onChange={(value) => void onToggleLookup(value)}
        label="Look up ISP and location for public IPs"
      />
      <p className="mt-1 text-2xs leading-relaxed text-faint">
        Sends only public session IPs to ipwho.is. Loopback and local-network addresses are never sent.
        {!anyPublic && " No session is currently on a public address."}
      </p>
    </div>

    {open && <SessionDetail
      session={open}
      onClose={() => setOpenId(null)}
      onRevoke={() => { setOpenId(null); void onRevoke(open.id); }}
    />}
  </div>;
}
