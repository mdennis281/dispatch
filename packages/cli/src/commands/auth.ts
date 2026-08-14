import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hash } from "@node-rs/argon2";
import { CmError } from "../core/manifest.js";

interface AuthFile {
  version: number;
  users: Array<{ username: string; owner: boolean; password?: { hash: string }; totp?: unknown }>;
}
interface AuthSessionsFile {
  version: number;
  sessions: Array<{ revokedAt?: number }>;
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}

/** Explicitly local recovery primitive; the command wrapper keeps the secret on stdin. */
export async function resetOwner(configDir: string, dataDir: string, password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new CmError("password must be 12–256 characters");
  const file = join(configDir, "auth.json");
  const sessionsFile = join(dataDir, "auth-sessions.json");
  let data: AuthFile;
  try { data = JSON.parse(await readFile(file, "utf8")) as AuthFile; }
  catch { throw new CmError(`cannot read ${file}`); }
  const owner = data.users.find((user) => user.owner);
  if (!owner) throw new CmError("no bootstrap owner exists");
  owner.password = { hash: await hash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 3, parallelism: 1 }) };
  delete owner.totp;
  let sessions: AuthSessionsFile = { version: 1, sessions: [] };
  try { sessions = JSON.parse(await readFile(sessionsFile, "utf8")) as AuthSessionsFile; } catch { /* no sessions yet */ }
  const now = Date.now();
  for (const session of sessions.sessions) session.revokedAt = now;
  const tmp = `${file}.${process.pid}.tmp`;
  const sessionsTmp = `${sessionsFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(sessionsTmp, JSON.stringify(sessions, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  await rename(sessionsTmp, sessionsFile);
  return owner.username;
}

export async function runAuthCommand(argv: string[]): Promise<void> {
  if (argv[0] !== "reset-owner") {
    throw new CmError("usage: dispatch auth reset-owner --config-dir <dir> --password-stdin");
  }
  const dirAt = argv.indexOf("--config-dir");
  const configured = dirAt >= 0 ? argv[dirAt + 1] : process.env.DISPATCH_CONFIG_DIR ?? process.env.CM_CONFIG_DIR;
  if (!configured) throw new CmError("--config-dir is required (or set DISPATCH_CONFIG_DIR)");
  if (!argv.includes("--password-stdin")) {
    throw new CmError("--password-stdin is required; passwords are never accepted in argv or environment variables");
  }
  const password = await stdin();
  const configDir = resolve(configured);
  const dataAt = argv.indexOf("--data-dir");
  const dataDir = resolve(dataAt >= 0 ? argv[dataAt + 1]! : process.env.DISPATCH_DATA_DIR ?? process.env.CM_DATA_DIR ?? configDir);
  const username = await resetOwner(configDir, dataDir, password);
  process.stdout.write(`Reset password and TOTP for owner ${username}; all sessions revoked.\n`);
}
