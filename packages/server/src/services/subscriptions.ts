/**
 * Subscriptions, server side: turning a stored subscription into a directory, an
 * env overlay, and a login-present flag.
 *
 * The shared half (`@dispatch/shared` `subscriptions.ts`) is pure and decides
 * WHICH subscription applies. This half knows the machine — home directory,
 * the server's own env, what is on disk — which is why "the provider's default
 * config dir" can only be answered here.
 *
 * Nothing in this file reads a credential. `loggedIn` is `existsSync` on the
 * provider's login file; the one reader of token contents in the app is still
 * `usage.ts`, and it only ever sends the token back to the provider it came from.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  endpointOrigin,
  providerFor,
  resolveSubscriptions,
  subscriptionFor,
  type Chat,
  type HarnessKind,
  type ResolvedSubscription,
  type Subscription,
  type SubscriptionSettings,
  type SubscriptionStatus,
} from "@dispatch/shared";
import type { HarnessAccount } from "../harness/types.js";

export interface MachineEnv {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Expand a leading `~` and make the path absolute. */
function expandDir(dir: string, home: string): string {
  const expanded = dir === "~" || /^~[\\/]/.test(dir) ? join(home, dir.slice(1)) : dir;
  return isAbsolute(expanded) ? expanded : resolve(home, expanded);
}

/**
 * A provider's default config dir on this machine: its env var when the server
 * was started with one — that is the dir every chat used before subscriptions
 * existed, and the one the runtime would pick with no overlay — else the home
 * default.
 */
export function defaultConfigDir(provider: HarnessKind, machine: MachineEnv = {}): string {
  const env = machine.env ?? process.env;
  const home = machine.home ?? homedir();
  const { configDirEnv, defaultConfigDir: rel } = providerFor(provider).account;
  const fromEnv = env[configDirEnv]?.trim();
  return fromEnv ? expandDir(fromEnv, home) : join(home, rel);
}

/** The config dir a subscription actually uses. */
export function configDirOf(sub: Subscription, machine: MachineEnv = {}): string {
  return sub.configDir
    ? expandDir(sub.configDir, machine.home ?? homedir())
    : defaultConfigDir(sub.provider, machine);
}

/** Two paths name the same directory (Windows compares case-insensitively). */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/**
 * A subscription as a harness consumes it.
 *
 * The env overlay is EMPTY when the dir is the provider's default. Setting the
 * var to the value it would resolve to anyway is harmless for the runtime, but
 * an empty overlay keeps a default-account chat's spawn byte-identical to what
 * it was before this feature — which is what makes shipping it low-risk.
 */
export function accountOf(sub: ResolvedSubscription, machine: MachineEnv = {}): HarnessAccount {
  const configDir = configDirOf(sub, machine);
  const isDefault = sameDir(configDir, defaultConfigDir(sub.provider, machine));
  const { configDirEnv, endpointEnv } = providerFor(sub.provider).account;
  return {
    subscriptionId: sub.id,
    configDir,
    env: {
      ...(isDefault ? {} : { [configDirEnv]: configDir }),
      // An endpoint provider's account IS its host, so unlike the config dir
      // this is overlaid whenever the subscription names one — including when
      // it happens to match the default. The two are not the same case: a dir
      // equal to the default was never chosen, while a host equal to the
      // default was, and a user who typed their loopback in deliberately
      // should not have it silently fall back to the server's ambient
      // `OLLAMA_HOST` if one is ever set.
      ...(endpointEnv && sub.host ? { [endpointEnv]: endpointOrigin(sub.host) } : {}),
    },
  };
}

/**
 * The subscription a CHAT runs under.
 *
 * A chat pinned to an account of its provider gets it. A chat with NO pin — one
 * predating subscriptions, or one created on an implicit account (see
 * `pinnedIdOf`) — has every native session in the provider's DEFAULT DIRECTORY,
 * so it resolves to the subscription pointing there, not to whatever the
 * provider's default subscription is today. A pin that no longer resolves (its
 * account was removed) takes the same directory rule before the provider
 * default: re-pointing the default at a second account must not strand a chat's
 * resume in a directory it is no longer run from.
 */
export function chatSubscription(
  settings: SubscriptionSettings | null | undefined,
  chat: Pick<Chat, "harness" | "subscriptionId"> & { harness: HarnessKind },
  machine: MachineEnv = {},
): ResolvedSubscription {
  const mine = resolveSubscriptions(settings).filter((s) => s.provider === chat.harness);
  const pinned = chat.subscriptionId ? mine.find((s) => s.id === chat.subscriptionId) : undefined;
  if (pinned) return pinned;
  const home = defaultConfigDir(chat.harness, machine);
  const legacy = mine.find((s) => sameDir(configDirOf(s, machine), home));
  return legacy ?? subscriptionFor(settings, chat.harness);
}

/** Every subscription with what the disk says about it, for the settings pane. */
export function subscriptionStatuses(
  settings: SubscriptionSettings | null | undefined,
  machine: MachineEnv = {},
): SubscriptionStatus[] {
  return resolveSubscriptions(settings).map((sub) => {
    const dir = configDirOf(sub, machine);
    return {
      ...sub,
      resolvedConfigDir: dir,
      dirExists: existsSync(dir),
      loggedIn: existsSync(join(dir, providerFor(sub.provider).account.loginFile)),
      isDefault: subscriptionFor(settings, sub.provider).id === sub.id,
      atDefaultDir: sameDir(dir, defaultConfigDir(sub.provider, machine)),
    };
  });
}

/* ----------------------------------------------------------- session transfer */

/**
 * Copy a Claude Code session from one config dir to another so `resume` finds it.
 *
 * Claude keeps a session at `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`,
 * with subagent transcripts beside it under `<sessionId>/`. The slug is found by
 * SEARCHING rather than recomputed from the cwd: Claude's slugging has changed
 * shape before (long paths get truncated and hashed), and a copy that lands in
 * the wrong slug dir is a resume that silently starts a blank session. Whatever
 * directory the file really is in, the copy goes to the same name.
 *
 * OVERWRITES the target's copy. A chat runs on one account at a time and a
 * resume keeps appending to the same session id, so the SOURCE is always the
 * newest copy — a switch back to an account the chat ran on before must replace
 * that account's stale file, or the resume there silently loses every turn taken
 * since it left.
 */
export async function transferClaudeSession(
  sessionId: string,
  fromDir: string,
  toDir: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false;
  const fromProjects = join(fromDir, "projects");
  let slugs: string[];
  try {
    slugs = await readdir(fromProjects);
  } catch {
    return false;
  }
  const file = `${sessionId}.jsonl`;
  const slug = slugs.find((s) => existsSync(join(fromProjects, s, file)));
  if (!slug) return false;
  const target = join(toDir, "projects", slug);
  try {
    await mkdir(target, { recursive: true });
    await cp(join(fromProjects, slug, file), join(target, file), { force: true });
    const sidecar = join(fromProjects, slug, sessionId);
    if (existsSync(sidecar)) {
      await cp(sidecar, join(target, sessionId), { recursive: true, force: true });
    }
    return existsSync(join(target, file));
  } catch {
    return false;
  }
}

/** Merge an account's env overlay onto the server's env for a spawn. */
export function envWithAccount(
  account: HarnessAccount | undefined,
): Record<string, string | undefined> | undefined {
  return account && Object.keys(account.env).length
    ? { ...process.env, ...account.env }
    : undefined;
}
