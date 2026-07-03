/**
 * Runtime configuration, loaded from environment with sensible local defaults.
 * No secrets: auth is the Claude subscription (~/.claude/.credentials.json),
 * never an API key.
 */
import { resolve } from "node:path";

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
const DEFAULT_DATA_DIR = resolve(
  "C:/Users/Michael/projects/zombie/claude-manager/.data",
);
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
