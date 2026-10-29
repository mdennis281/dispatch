/**
 * `dispatch token …` — mint, list and revoke integration tokens from a terminal.
 *
 * OFFLINE, against the instance's data directory, like `auth reset-owner`:
 * there is no credential a shell could present to the HTTP surface that is not
 * itself one of these tokens, so the first one has to be minted without the
 * server. The server notices the new row by the file's mtime and needs no
 * restart — see `services/integration-tokens.ts`.
 *
 * Which instance is decided by `--data-dir` (or `DISPATCH_DATA_DIR`): stable and
 * dev keep separate data roots, and a token is per instance because it is
 * persisted beside that instance's sessions.
 *
 * The token value is printed ONCE, to stdout, and nowhere else.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  INTEGRATION_SCOPES,
  INTEGRATION_TRUST_LEVELS,
  type IntegrationTokenCreateRequest,
  type IntegrationTrust,
} from "@dispatch/shared";
import { CmError } from "../core/manifest.js";
import { parseArgs, flag, has, type ParsedArgs } from "../core/args.js";
import {
  integrationTokensPath,
  listIntegrationTokens,
  mintIntegrationToken,
  parseExpiry,
  revokeIntegrationToken,
  summarizeIntegrationToken,
} from "../core/integration-tokens.js";

const HELP = `dispatch token — integration tokens for bots and scripts

Usage:
  dispatch token create --name <name> --scopes <a,b,…> [--projects <id,…>] [--expires <30d|12h|ISO>] [--trust <external|owner>]
  dispatch token list [--all]
  dispatch token revoke <id>

Every command needs the instance's roots:
  --config-dir <dir>   or DISPATCH_CONFIG_DIR   (where config.json says whether auth is on)
  --data-dir <dir>     or DISPATCH_DATA_DIR     (where the token file lives; per instance)

Scopes: ${INTEGRATION_SCOPES.join(", ")}

Trust (${INTEGRATION_TRUST_LEVELS.join(", ")}; default external): whose words a chat
should read the token's messages as. "owner" is for a bot that relays YOUR
instructions — agents then act on them as if you typed them here.

Minting refuses while authentication is disabled: an open install has nothing
to scope. The token is printed once and never stored in clear.
`;

interface Roots {
  configDir: string;
  dataDir: string;
}

function roots(args: ParsedArgs): Roots {
  const configured = flag(args, "config-dir") ?? process.env.DISPATCH_CONFIG_DIR ?? process.env.CM_CONFIG_DIR;
  if (!configured) throw new CmError("--config-dir is required (or set DISPATCH_CONFIG_DIR)");
  const data = flag(args, "data-dir") ?? process.env.DISPATCH_DATA_DIR ?? process.env.CM_DATA_DIR;
  if (!data) throw new CmError("--data-dir is required (or set DISPATCH_DATA_DIR) — tokens are per instance");
  return { configDir: resolve(configured), dataDir: resolve(data) };
}

/**
 * The auth gate, as config.json records it. Read raw rather than through the
 * server's settings schema: the CLI must answer the one question — is auth on —
 * without dragging the whole AppSettings validator into a terminal command.
 */
async function authState(configDir: string): Promise<{ enabled: boolean; epoch: number }> {
  let enabled = false;
  try {
    const raw = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as {
      auth?: { enabled?: unknown };
    };
    enabled = raw.auth?.enabled === true;
  } catch {
    /* no config yet is the same as auth off */
  }
  let epoch = 0;
  try {
    const raw = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")) as {
      sessionEpoch?: unknown;
    };
    if (typeof raw.sessionEpoch === "number") epoch = raw.sessionEpoch;
  } catch {
    /* never bootstrapped */
  }
  return { enabled, epoch };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function emitJson(args: ParsedArgs, payload: unknown): boolean {
  if (!has(args, "json")) return false;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

export async function runTokenCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const args = parseArgs(rest);
  switch (sub) {
    case "create":
      return create(args);
    case "list":
      return list(args);
    case "revoke":
      return revoke(args);
    default:
      throw new CmError(`unknown token command "${sub}"\n\n${HELP}`);
  }
}

async function create(args: ParsedArgs): Promise<void> {
  const { configDir, dataDir } = roots(args);
  const auth = await authState(configDir);
  // An unauthenticated install has nothing to scope: every caller already has
  // everything, and a token would only pretend otherwise.
  if (!auth.enabled) throw new CmError("authentication is disabled on this install; enable it before minting a token");
  const name = flag(args, "name");
  if (!name) throw new CmError("--name is required");
  const expires = flag(args, "expires");
  const request: IntegrationTokenCreateRequest = {
    name,
    scopes: splitList(flag(args, "scopes")),
    ...(flag(args, "projects") ? { projectIds: splitList(flag(args, "projects")) } : {}),
    ...(expires ? { expiresAt: parseExpiry(expires) } : {}),
    // Passed through unchecked: the core validates it with the same words the
    // server uses, so a typo is refused here exactly as it is in Settings.
    ...(flag(args, "trust") ? { trust: flag(args, "trust") as IntegrationTrust } : {}),
  };
  const { token, row } = await mintIntegrationToken(integrationTokensPath(dataDir), request, {
    authEpoch: auth.epoch,
  });
  const summary = summarizeIntegrationToken(row);
  if (emitJson(args, { token, ...summary })) return;
  process.stdout.write(
    `Created token "${summary.name}" (${summary.id})\n` +
      `  scopes:   ${summary.scopes.join(", ")}\n` +
      (summary.projectIds ? `  projects: ${summary.projectIds.join(", ")}\n` : "") +
      (summary.expiresAt ? `  expires:  ${new Date(summary.expiresAt).toISOString()}\n` : "") +
      `  trust:    ${summary.trust}\n` +
      `\n${token}\n\n` +
      `This is the only time it will be shown.\n`,
  );
}

async function list(args: ParsedArgs): Promise<void> {
  const { dataDir } = roots(args);
  const rows = (await listIntegrationTokens(integrationTokensPath(dataDir))).map(summarizeIntegrationToken);
  const shown = has(args, "all") ? rows : rows.filter((r) => r.revokedAt === undefined);
  if (emitJson(args, shown)) return;
  if (!shown.length) {
    process.stdout.write(has(args, "all") ? "No tokens.\n" : "No active tokens (use --all to include revoked).\n");
    return;
  }
  for (const r of shown) {
    const state = r.revokedAt
      ? "revoked"
      : r.expiresAt && r.expiresAt <= Date.now()
        ? "expired"
        : "active";
    const used = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : "never";
    process.stdout.write(`${r.id}  ${r.name}  [${state}]  trust=${r.trust}  scopes=${r.scopes.join(",")}  last used ${used}\n`);
  }
}

async function revoke(args: ParsedArgs): Promise<void> {
  const { dataDir } = roots(args);
  const id = args.positionals[0];
  if (!id) throw new CmError("usage: dispatch token revoke <id>");
  const found = await revokeIntegrationToken(integrationTokensPath(dataDir), id);
  if (!found) throw new CmError(`no token with id "${id}"`);
  if (emitJson(args, { id, revoked: true })) return;
  process.stdout.write(`Revoked ${id}.\n`);
}
