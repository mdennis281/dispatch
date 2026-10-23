/**
 * After install: Check for updates, Update, Uninstall (#409).
 *
 * Shared because the CLI (`dispatch plugin update`) and the server (Settings →
 * Plugins) must reach the same verdict on the same remote. Everything here is
 * pure — the network is the caller's: it hands in `git ls-remote --symref`
 * output and two reports, and gets back a decision and a diff. That is also
 * what lets the tests feed canned ref lists instead of a network.
 *
 * See docs/plugins.md → "Updating and uninstalling".
 */
import * as z from "zod";
import { PLUGIN_CAPABILITY_LINES, PluginInspectionSchema, type PluginInspection } from "./plugin-inspection.js";
import { PluginInfoSchema, PluginOriginSchema, PluginRefKindSchema, type PluginGitSource } from "./plugin-manifest.js";

/* ------------------------------------------------------------ remote refs */

/** `git ls-remote --symref` output, parsed. */
export interface RemoteRefs {
  /** `refs/heads/main` → sha, `refs/tags/v1` → sha (peeled `^{}` wins for annotated tags). */
  refs: Map<string, string>;
  /** What `HEAD` points at, when the remote said (`--symref`). */
  headRef?: string;
  headSha?: string;
}

export function parseLsRemote(out: string): RemoteRefs {
  const refs = new Map<string, string>();
  let headRef: string | undefined;
  let headSha: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    const sym = /^ref:\s+(\S+)\s+HEAD$/.exec(line);
    if (sym) {
      headRef = sym[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (!m) continue;
    const [, sha, name] = m as unknown as [string, string, string];
    if (name === "HEAD") {
      headSha = sha;
    } else if (name.endsWith("^{}")) {
      // An annotated tag's peeled commit. The tag OBJECT's sha would not name
      // a tree a tarball can be cut from, so the commit replaces it.
      refs.set(name.slice(0, -3), sha);
    } else if (!refs.has(name)) {
      refs.set(name, sha);
    }
  }
  return { refs, headRef, headSha };
}

/* ------------------------------------------------------------ semver tags */

interface TagVersion {
  /** Everything before the version: `v`, `hello-server-v`, `hello-server@`, or `""`. */
  prefix: string;
  nums: [number, number, number];
  pre?: string;
}

/**
 * `v1.2.3`, `1.2.3`, `hello-server-v1.2.3-rc.1` → its prefix and version.
 * The prefix is kept so a monorepo that tags each plugin (`a-v1.0.0`,
 * `b-v2.0.0`) only ever compares a plugin's tags with its own.
 */
export function parseTagVersion(tag: string): TagVersion | null {
  // Tag names come from someone else's remote. One regex with a lazy prefix
  // (`^(.*?)(\d+)\.…`) backtracks polynomially on a name like "0000…" — so try
  // each place a version could START (a digit not preceded by one) against an
  // anchored pattern with no overlapping quantifiers, under a length cap.
  if (tag.length > 200) return null;
  for (let i = 0; i < tag.length; i++) {
    if (!isDigit(tag[i]) || (i > 0 && isDigit(tag[i - 1]))) continue;
    const m = VERSION_AT.exec(tag.slice(i));
    if (m) return { prefix: tag.slice(0, i), nums: [Number(m[1]), Number(m[2]), Number(m[3])], ...(m[4] ? { pre: m[4] } : {}) };
  }
  return null;
}

const VERSION_AT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Semver precedence, with prerelease identifiers compared field by field. */
export function compareTagVersions(a: TagVersion, b: TagVersion): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i]! - b.nums[i]!;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const pa = a.pre.split(".");
  const pb = b.pre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The newest tag sharing `current`'s prefix that is semver-greater than it, or
 * null. Prereleases are only candidates when `current` is one: someone who
 * installed `v1.2.0` did not ask to be offered `v1.3.0-beta.1`.
 */
export function newerTag(current: string, tags: Iterable<string>): string | null {
  const cur = parseTagVersion(current);
  if (!cur) return null;
  let best: { tag: string; v: TagVersion } | null = null;
  for (const tag of tags) {
    const v = parseTagVersion(tag);
    if (!v || v.prefix !== cur.prefix) continue;
    if (v.pre && !cur.pre) continue;
    if (compareTagVersions(v, cur) <= 0) continue;
    if (!best || compareTagVersions(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag ?? null;
}

/* ----------------------------------------------------- update resolution */

export type UpdateTarget =
  | { status: "pinned" }
  | { status: "up-to-date"; ref: string; sha: string; note?: string }
  | { status: "available"; ref: string; sha: string; note?: string }
  | { status: "gone"; message: string };

/**
 * What the recorded source would update to, given the remote's refs now.
 *
 *   branch — its tip. A branch that no longer exists is `gone`, not "up to
 *            date": the owner should hear that the thing it follows vanished.
 *   tag    — the newest semver-greater tag with the same prefix. Failing that,
 *            the SAME tag when it was moved (force-pushed) since install — that
 *            is new code under an old name, and pretending otherwise would
 *            leave the owner on a commit the author withdrew.
 *   sha    — pinned. Nothing to resolve; the caller says so without a fetch.
 */
export function resolveUpdateTarget(source: Pick<PluginGitSource, "ref" | "refKind" | "sha">, remote: RemoteRefs): UpdateTarget {
  if (source.refKind === "sha") return { status: "pinned" };
  if (source.refKind === "branch") {
    const sha = source.ref === "HEAD" ? remote.headSha : remote.refs.get(`refs/heads/${source.ref}`);
    if (!sha) return { status: "gone", message: `branch "${source.ref}" no longer exists on the remote` };
    return sha === source.sha ? { status: "up-to-date", ref: source.ref, sha } : { status: "available", ref: source.ref, sha };
  }
  const tags = [...remote.refs.keys()].filter((r) => r.startsWith("refs/tags/")).map((r) => r.slice("refs/tags/".length));
  const next = newerTag(source.ref, tags);
  if (next) return { status: "available", ref: next, sha: remote.refs.get(`refs/tags/${next}`)! };
  const same = remote.refs.get(`refs/tags/${source.ref}`);
  if (same && same !== source.sha) {
    return { status: "available", ref: source.ref, sha: same, note: `tag "${source.ref}" was moved to a different commit since it was installed` };
  }
  if (!same) {
    return {
      status: "up-to-date",
      ref: source.ref,
      sha: source.sha,
      note: parseTagVersion(source.ref)
        ? `tag "${source.ref}" is no longer on the remote, and no newer one is`
        : `"${source.ref}" is not a version tag, so there is nothing newer to look for`,
    };
  }
  return {
    status: "up-to-date",
    ref: source.ref,
    sha: same,
    ...(parseTagVersion(source.ref) ? {} : { note: `"${source.ref}" is not a version tag, so there is nothing newer to look for` }),
  };
}

/* ------------------------------------------------------------ the diff */

/**
 * The part of a report an update diff compares. `PluginInspection` satisfies
 * it; the CLI, which has no scanner, builds one from the manifest and its
 * contribution files with `hooks: []`.
 */
export type PluginSurface = Pick<
  PluginInspection,
  "version" | "capabilities" | "secrets" | "oauth" | "contributions" | "mismatches" | "hooks" | "entries"
>;

export const PluginChangeSchema = z.object({
  kind: z.enum(["capability", "secret", "oauth", "mcpServer", "process", "mismatch", "entry", "contribution", "hook"]),
  change: z.enum(["added", "removed", "changed"]),
  /** As the card shows it: `chats:write`, `secret:GITHUB_TOKEN`, `mcp:search`, `bus.on("chat-status")`. */
  label: z.string(),
  detail: z.string().optional(),
  /** Grants the plugin something it could not do before. Escalations are listed first, and the Update button says so. */
  escalation: z.boolean(),
  /** For a `hook`: its kind, so `io` (network, processes, filesystem) can be shown first. */
  hookKind: z.string().optional(),
});
export type PluginChange = z.infer<typeof PluginChangeSchema>;

export const PluginUpdateDiffSchema = z.object({
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  /** Everything that WIDENS what the plugin can do, in the order the card shows them. */
  escalations: z.array(PluginChangeSchema),
  /** Everything else: what it gave up, contributions that came or went, and changes to "hooks used". */
  changes: z.array(PluginChangeSchema),
});
export type PluginUpdateDiff = z.infer<typeof PluginUpdateDiffSchema>;

const ESCALATION_ORDER: PluginChange["kind"][] = ["capability", "secret", "oauth", "mcpServer", "process", "mismatch", "entry", "contribution"];

function commandLine(x: { command?: string; args?: string[]; url?: string; transport?: string }): string {
  return x.command ? [x.command, ...(x.args ?? [])].join(" ") : (x.url ?? x.transport ?? "");
}

/**
 * What changes between the installed copy (`from`) and the update (`to`).
 *
 * An ESCALATION is anything the owner would have had to consent to on a fresh
 * install and did not consent to on this one: a new capability, a new secret,
 * a new OAuth client or new scopes on an existing one, a new or re-pointed MCP
 * server or process (it runs different code), a newly undeclared use, a
 * server or browser half where there was none, and a new instruction file
 * (injected into every session). Everything else is a plain change.
 */
export function diffPluginSurfaces(from: PluginSurface, to: PluginSurface): PluginUpdateDiff {
  const out: PluginChange[] = [];
  const push = (c: PluginChange) => out.push(c);

  const caps = (s: PluginSurface) => new Set(s.capabilities.map((c) => c.name));
  const fromCaps = caps(from);
  const toCaps = caps(to);
  for (const c of toCaps) {
    if (!fromCaps.has(c)) push({ kind: "capability", change: "added", label: c, detail: PLUGIN_CAPABILITY_LINES[c], escalation: true });
  }
  for (const c of fromCaps) if (!toCaps.has(c)) push({ kind: "capability", change: "removed", label: c, escalation: false });

  const fromSecrets = new Set(from.secrets);
  const toSecrets = new Set(to.secrets);
  for (const s of toSecrets) if (!fromSecrets.has(s)) push({ kind: "secret", change: "added", label: `secret:${s}`, escalation: true });
  for (const s of fromSecrets) if (!toSecrets.has(s)) push({ kind: "secret", change: "removed", label: `secret:${s}`, escalation: false });

  const fromOAuth = new Map(from.oauth.map((o) => [o.name, o]));
  const toOAuth = new Map(to.oauth.map((o) => [o.name, o]));
  for (const [name, o] of toOAuth) {
    const was = fromOAuth.get(name);
    const scopes = o.scopes.length ? ` · scopes ${o.scopes.join(" ")}` : "";
    if (!was) {
      push({ kind: "oauth", change: "added", label: `oauth:${name}`, detail: `signs in to ${o.provider}${scopes}`, escalation: true });
      continue;
    }
    const newScopes = o.scopes.filter((s) => !was.scopes.includes(s));
    if (was.provider !== o.provider) {
      push({ kind: "oauth", change: "changed", label: `oauth:${name}`, detail: `now signs in to ${o.provider} (was ${was.provider})${scopes}`, escalation: true });
    } else if (newScopes.length) {
      push({ kind: "oauth", change: "changed", label: `oauth:${name}`, detail: `asks for more scopes: ${newScopes.join(" ")}`, escalation: true });
    } else if (o.scopes.length < was.scopes.length) {
      push({ kind: "oauth", change: "changed", label: `oauth:${name}`, detail: `asks for fewer scopes`, escalation: false });
    }
  }
  for (const name of fromOAuth.keys()) if (!toOAuth.has(name)) push({ kind: "oauth", change: "removed", label: `oauth:${name}`, escalation: false });

  const fromMcp = new Map(from.contributions.mcpServers.map((s) => [s.name, s]));
  const toMcp = new Map(to.contributions.mcpServers.map((s) => [s.name, s]));
  for (const [name, s] of toMcp) {
    const was = fromMcp.get(name);
    if (!was) push({ kind: "mcpServer", change: "added", label: `mcp:${name}`, detail: commandLine(s), escalation: true });
    else if (commandLine(was) !== commandLine(s)) {
      push({ kind: "mcpServer", change: "changed", label: `mcp:${name}`, detail: `now runs ${commandLine(s)} (was ${commandLine(was)})`, escalation: true });
    }
  }
  for (const name of fromMcp.keys()) if (!toMcp.has(name)) push({ kind: "mcpServer", change: "removed", label: `mcp:${name}`, escalation: false });

  const fromProc = new Map(from.contributions.processes.map((p) => [p.id, p]));
  const toProc = new Map(to.contributions.processes.map((p) => [p.id, p]));
  for (const [id, p] of toProc) {
    const was = fromProc.get(id);
    const line = commandLine(p);
    if (!was) push({ kind: "process", change: "added", label: `process:${id}`, detail: `${line}${p.autostart ? " · starts with the plugin" : ""}`, escalation: true });
    else if (commandLine(was) !== line) {
      push({ kind: "process", change: "changed", label: `process:${id}`, detail: `now runs ${line} (was ${commandLine(was)})`, escalation: true });
    } else if (p.autostart && !was.autostart) {
      push({ kind: "process", change: "changed", label: `process:${id}`, detail: "now starts with the plugin", escalation: true });
    }
  }
  for (const id of fromProc.keys()) if (!toProc.has(id)) push({ kind: "process", change: "removed", label: `process:${id}`, escalation: false });

  const fromUndeclared = new Set(from.mismatches.undeclared.map((u) => u.capability));
  for (const u of to.mismatches.undeclared) {
    if (!fromUndeclared.has(u.capability)) {
      push({ kind: "mismatch", change: "added", label: `uses ${u.capability}`, detail: `not declared — seen: ${u.because.join(", ")}`, escalation: true });
    }
  }

  if (to.entries.server && !from.entries.server) {
    push({ kind: "entry", change: "added", label: "server", detail: `now runs code in-process: ${to.entries.server.path}`, escalation: true });
  }
  if (to.entries.client && !from.entries.client) {
    push({ kind: "entry", change: "added", label: "client", detail: `now runs code in your browser: ${to.entries.client.path}`, escalation: true });
  }
  if (from.entries.server && !to.entries.server) push({ kind: "entry", change: "removed", label: "server", escalation: false });
  if (from.entries.client && !to.entries.client) push({ kind: "entry", change: "removed", label: "client", escalation: false });

  for (const key of ["instructions", "modes", "skills", "personas"] as const) {
    const was = new Set(from.contributions[key]);
    const now = new Set(to.contributions[key]);
    for (const n of now) {
      if (!was.has(n)) {
        push({
          kind: "contribution",
          change: "added",
          label: `${key}:${n}`,
          ...(key === "instructions" ? { detail: "injected into every session" } : {}),
          escalation: key === "instructions",
        });
      }
    }
    for (const n of was) if (!now.has(n)) push({ kind: "contribution", change: "removed", label: `${key}:${n}`, escalation: false });
  }

  const hookKey = (h: { kind: string; label: string }) => `${h.kind}\u0000${h.label}`;
  const fromHooks = new Map(from.hooks.map((h) => [hookKey(h), h]));
  const toHooks = new Map(to.hooks.map((h) => [hookKey(h), h]));
  for (const [k, h] of toHooks) {
    if (!fromHooks.has(k)) push({ kind: "hook", change: "added", label: h.label, detail: `${h.file}:${h.line}`, escalation: false, hookKind: h.kind });
  }
  for (const [k, h] of fromHooks) {
    if (!toHooks.has(k)) push({ kind: "hook", change: "removed", label: h.label, escalation: false, hookKind: h.kind });
  }

  const rank = (c: PluginChange) => ESCALATION_ORDER.indexOf(c.kind);
  const escalations = out.filter((c) => c.escalation).sort((a, b) => rank(a) - rank(b));
  // Plain changes: removals and contributions first, then hooks — `io` hooks
  // (network, child processes, the filesystem) ahead of the rest, additions
  // ahead of removals.
  const changeRank = (c: PluginChange) =>
    c.kind !== "hook" ? rank(c) : 100 + (c.hookKind === "io" ? 0 : 10) + (c.change === "added" ? 0 : 1);
  // `sort` is stable, so within a rank the order above (added before removed) holds.
  const changes = out.filter((c) => !c.escalation).sort((a, b) => changeRank(a) - changeRank(b));
  return {
    ...(from.version ? { fromVersion: from.version } : {}),
    ...(to.version ? { toVersion: to.version } : {}),
    escalations,
    changes,
  };
}

/* ------------------------------------------------------------- API shapes */

/**
 * `POST /api/plugins/:id/check-update`.
 *
 *   available     — a newer commit exists; `target`, `diff` and `inspection` describe it
 *   up-to-date    — the recorded commit is the one the ref resolves to
 *   pinned        — installed at a sha; there is nothing to follow
 *   unsupported   — no git source to check: built-in, linked, local, or unknown (`message` says which)
 *   error         — the remote could not be read, or the branch is gone (`message`)
 */
export const PluginUpdateCheckSchema = z.object({
  id: z.string(),
  status: z.enum(["available", "up-to-date", "pinned", "unsupported", "error"]),
  origin: PluginOriginSchema,
  message: z.string().optional(),
  current: z
    .object({ ref: z.string(), refKind: PluginRefKindSchema, sha: z.string(), version: z.string().optional() })
    .optional(),
  target: z.object({ ref: z.string(), sha: z.string(), version: z.string().optional() }).optional(),
  diff: PluginUpdateDiffSchema.optional(),
  /** The target's full #399 report — warnings, refusal, and the rest of the card. */
  inspection: PluginInspectionSchema.optional(),
  checkedAt: z.number(),
});
export type PluginUpdateCheck = z.infer<typeof PluginUpdateCheckSchema>;

/** `POST /api/plugins/:id/update` — the target the owner was shown. Refused if the ref has moved on since. */
export const PluginUpdateRequestSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, "sha must be a full 40-character commit hash"),
});

export const PluginUpdateResultSchema = z.object({
  id: z.string(),
  fromSha: z.string(),
  sha: z.string(),
  ref: z.string(),
  /** Always true: the new files load on the next start. */
  needsRestart: z.literal(true),
  plugin: PluginInfoSchema.optional(),
});
export type PluginUpdateResult = z.infer<typeof PluginUpdateResultSchema>;

/** `GET /api/plugins/:id/uninstall` — exactly what Uninstall would remove, so the dialog can name it. */
export const PluginUninstallPreviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  origin: PluginOriginSchema,
  /** The entry under `<configDir>/plugins/`. */
  dir: z.string(),
  /** `link` — only the junction goes; `linkTarget` is never touched. */
  removes: z.enum(["directory", "link"]),
  linkTarget: z.string().optional(),
  /** Its server half is running now — Uninstall deactivates it first. */
  active: z.boolean(),
  hasClient: z.boolean(),
  /** What the "also delete its data" box would remove. */
  data: z.object({
    /** A `plugins.<id>` entry with settings or a toggle exists in config.json. */
    settings: z.boolean(),
    /** Rows in THIS instance's `plugin_kv`. */
    kvKeys: z.number().int(),
    /** Secrets the manifest lists that are stored (global scope) and no other installed plugin lists. */
    secrets: z.array(z.string()),
    /** Secrets it lists that another plugin lists too — kept, because deleting them would break that one. */
    sharedSecrets: z.array(z.object({ name: z.string(), alsoUsedBy: z.array(z.string()) })),
    /** OAuth clients with stored tokens in THIS instance. */
    oauth: z.array(z.string()),
  }),
});
export type PluginUninstallPreview = z.infer<typeof PluginUninstallPreviewSchema>;

export const PluginUninstallRequestSchema = z.object({ purge: z.boolean().optional() });

export const PluginUninstallResultSchema = z.object({
  id: z.string(),
  removed: z.enum(["directory", "link"]),
  /** It was running and was deactivated in place — routes, listeners, processes and contributions are gone now. */
  deactivated: z.boolean(),
  /** Something it loaded outlives the uninstall until a restart or reload; `note` says what. */
  needsRestart: z.boolean(),
  note: z.string().optional(),
  purged: z
    .object({ settings: z.boolean(), kvKeys: z.number().int(), secrets: z.array(z.string()), oauth: z.array(z.string()) })
    .optional(),
});
export type PluginUninstallResult = z.infer<typeof PluginUninstallResultSchema>;
