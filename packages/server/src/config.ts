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
  /** Absolute path to the on-disk data dir (JSON + JSONL, no DB). */
  dataDir: string;
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
  return {
    port: intFromEnv("CM_PORT", DEFAULT_PORT),
    host: env.CM_HOST?.trim() || DEFAULT_HOST,
    dataDir,
    maxActiveSessions: intFromEnv("CM_MAX_ACTIVE_SESSIONS", DEFAULT_MAX_ACTIVE),
  };
}

export const config: ServerConfig = loadConfig();
