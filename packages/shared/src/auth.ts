/** Provider-neutral identity and session contracts shared by server and SPA. */
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

export interface AuthSessionSummary {
  id: string;
  current: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  userAgent: string;
  ip?: string;
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
  passkeys: Array<{ id: string; name: string; createdAt: number; lastUsedAt?: number }>;
}

export interface AuthSetupCode {
  code: string;
  url: string;
  expiresAt: number;
}
