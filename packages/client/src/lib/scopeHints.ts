/**
 * What each integration scope means, in the words a human reads before
 * granting it. Shared by the token-create form and the OAuth consent page so
 * the two never describe one scope two ways.
 */
import { INTEGRATION_FIXED_SCOPES, type IntegrationScope } from "@dispatch/shared";

export const SCOPE_HINT: Record<(typeof INTEGRATION_FIXED_SCOPES)[number], string> = {
  "chats:read": "List chats and read transcripts",
  "chats:write": "Send messages into chats",
  "attention:read": "See what is waiting on a human",
  "attention:answer": "Answer question cards",
  "memory:read": "Read project memory",
  "memory:write": "Write project memory",
  "projects:read": "List projects",
  "webhooks:manage": "Manage its own webhook subscriptions",
};

/** A hint for any scope, including the `tools:<category>` ones. */
export function scopeHint(scope: IntegrationScope): string {
  if (scope.startsWith("tools:")) return `Call Dispatch's ${scope.slice("tools:".length)} tools over MCP`;
  return SCOPE_HINT[scope as keyof typeof SCOPE_HINT] ?? scope;
}
