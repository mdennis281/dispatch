/**
 * Runtime configuration, loaded from environment with sensible local defaults.
 * No secrets: auth is the Claude subscription (~/.claude/.credentials.json),
 * never an API key.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export interface ServerConfig {
  /** HTTP + WebSocket port. */
  port: number;
  /** Bind host. */
  host: string;
  /**
   * Absolute path to the STATE dir — chats, checkpoints, runners (JSON + JSONL,
   * no DB). Per-instance: two processes must never share this (see Store).
   */
  dataDir: string;
  /**
   * Absolute path to the CONFIG dir — settings, projects, agents, modes. Safe to
   * point two instances (stable + dev) at one shared location.
   *
   * UNDEFINED unless `CM_CONFIG_DIR` is set, and deliberately so: the Store then
   * falls back to `dataDir` (the original single-root layout). Leaving it unset
   * rather than eagerly resolving it is what keeps `{ ...loadConfig(), dataDir:
   * tmp }` — the shape every test uses — from silently pointing config reads at
   * the developer's REAL `.data` while state goes to a temp dir.
   */
  configDir?: string;
  /** Max concurrently-active SDK sessions (idle chats don't count). */
  maxActiveSessions: number;
}

const DEFAULT_PORT = 4319;
const DEFAULT_HOST = "127.0.0.1";
/**
 * The app root = nearest ancestor of this module containing `pnpm-workspace.yaml`.
 * Keeps `.data` co-located with the app so the whole folder stays portable — moving
 * or renaming the app dir just works (no baked-in absolute path). `CM_DATA_DIR`
 * still overrides.
 */
function findAppRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: built layout is <root>/packages/server/dist/<file>.js → up three.
  return resolve(start, "../../..");
}

const DEFAULT_DATA_DIR = resolve(findAppRoot(), ".data");
const DEFAULT_MAX_ACTIVE = 6;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Build the effective config from process.env (call once at boot). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.CM_DATA_DIR
    ? resolve(env.CM_DATA_DIR)
    : DEFAULT_DATA_DIR;
  // Left undefined when unset => single-root layout, byte-identical to the
  // pre-split behaviour. Only the desktop/stable deployment sets it.
  const configDir = env.CM_CONFIG_DIR ? resolve(env.CM_CONFIG_DIR) : undefined;
  return {
    port: intFromEnv("CM_PORT", DEFAULT_PORT),
    host: env.CM_HOST?.trim() || DEFAULT_HOST,
    dataDir,
    ...(configDir ? { configDir } : {}),
    maxActiveSessions: intFromEnv("CM_MAX_ACTIVE_SESSIONS", DEFAULT_MAX_ACTIVE),
  };
}

export const config: ServerConfig = loadConfig();
