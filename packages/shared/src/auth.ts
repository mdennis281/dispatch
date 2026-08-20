/** Provider-neutral identity and session contracts shared by server and SPA. */
import type { SessionClient } from "./user-agent.js";

export type AuthMethod = "password" | "passkey";

export interface AuthUserSummary {
  id: string;
  username: string;
  displayName: string;
  owner: boolean;
  disabled: boolean;
  createdAt: number;
  hasPassword: boolean;
  passkeyCount: number;
  totpEnabled: boolean;
}

/**
 * Where a session's IP sits. Only `public` addresses can be geolocated at all;
 * the rest are stated as what they are rather than looked up and blanked.
 */
export type SessionNetworkScope = "loopback" | "private" | "public" | "unknown";

export interface SessionNetwork {
  scope: SessionNetworkScope;
  /** Owning network, from the IP lookup — e.g. "Frontier Communications". */
  isp?: string;
  /** Organisation, when the provider reports one distinct from the ISP. */
  org?: string;
  city?: string;
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, for the flag the SPA renders. */
  countryCode?: string;
  timezone?: string;
  /** When the lookup answered. Absent when no lookup has run. */
  lookedUpAt?: number;
  /** Why there is no geo data, when a lookup was attempted and failed. */
  error?: string;
}

export interface AuthSessionSummary {
  id: string;
  current: boolean;
  createdAt: number;
  /** Last refresh-token rotation — i.e. last re-authentication, not last use. */
  lastUsedAt: number;
  /**
   * Last authenticated request or socket ticket from this session. This is the
   * "last seen" a human means; `lastUsedAt` only moves every ACCESS_SECONDS.
   */
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  userAgent: string;
  /** Parsed from `userAgent` server-side so both surfaces agree on the label. */
  client: SessionClient;
  ip?: string;
  network: SessionNetwork;
}

export interface AuthStatus {
  enabled: boolean;
  configured: boolean;
  firstRunDismissed: boolean;
  canonicalUrl?: string;
  rpId?: string;
  user: AuthUserSummary | null;
}

export interface AuthSessionResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUserSummary;
}

export interface AuthSecurityOverview {
  user: AuthUserSummary;
  sessions: AuthSessionSummary[];
  /** Whether public session IPs are being geolocated (Settings opt-out). */
  ipLookup: boolean;
  passkeys: Array<{ id: string; name: string; createdAt: number; lastUsedAt?: number }>;
}

/** A pending authenticator enrollment: the key to type, and the URI to scan. */
export interface AuthTotpSetup {
  secret: string;
  uri: string;
}

export interface AuthSetupCode {
  code: string;
  url: string;
  expiresAt: number;
}
