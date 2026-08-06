/**
 * args — a tiny flag parser plus the `dispatch mcp add` flag→transport mapping.
 *
 * The flag surface deliberately MIRRORS `claude mcp add`, because that's the
 * syntax every published MCP server's README already shows and the syntax users
 * have muscle memory for:
 *
 *   dispatch mcp add <name> [-e KEY=VAL]... -- <command> [args...]
 *   dispatch mcp add <name> --transport http --url <url> [-H "Key: Value"]...
 *
 * Kept dependency-free on purpose: a CLI that projects run on every machine
 * shouldn't drag in a parser library for ~15 flags.
 */
import { ManifestMcpTransportSchema, type ManifestMcpTransport } from "@dispatch/shared";
import { CmError } from "./manifest.js";

/** A parsed argv: ordered positionals, repeatable flags, and post-`--` argv. */
export interface ParsedArgs {
  positionals: string[];
  /** Flag → every value it was given (a bare boolean flag records `""`). */
  flags: Map<string, string[]>;
  /** Everything after a bare `--`, verbatim (the stdio command + its args). */
  rest: string[];
  /** True when `--` appeared, even if nothing followed it. */
  hasRest: boolean;
}

/** Long flags that take a value; everything else is treated as a boolean. */
const VALUE_FLAGS = new Set([
  "transport",
  "command",
  "url",
  "env",
  "header",
  "dir",
  "scope",
]);

/** Short aliases, expanded before dispatch. */
const SHORT: Record<string, string> = {
  e: "env",
  H: "header",
  C: "dir",
  t: "transport",
  h: "help",
  f: "force",
};

/**
 * Parse an argv slice. Supports `--flag value`, `--flag=value`, repeated flags,
 * short aliases, and a `--` separator after which nothing is interpreted.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  let hasRest = false;

  const push = (name: string, value: string): void => {
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (hasRest) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      hasRest = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next === "--") throw new CmError(`--${body} needs a value.`);
        push(body, next);
        i++;
        continue;
      }
      push(body, "");
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const name = SHORT[arg.slice(1)];
      if (!name) throw new CmError(`Unknown flag "${arg}".`);
      if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined) throw new CmError(`${arg} needs a value.`);
        push(name, next);
        i++;
        continue;
      }
      push(name, "");
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags, rest, hasRest };
}

/** First value of a flag, or undefined. */
export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

/** Whether a boolean flag was passed at all. */
export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Every value of a repeatable flag. */
export function all(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

/* ------------------------------------------------------- key/value pairs */

/** Parse repeated `KEY=VALUE` env flags. A missing `=` is a user error. */
export function parseEnvPairs(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq <= 0) throw new CmError(`Invalid --env "${value}" — expected KEY=VALUE.`);
    out[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return out;
}

/**
 * Parse repeated header flags. Accepts both `"Key: Value"` (the HTTP-ish form
 * `claude mcp add` uses) and `Key=Value`, since both appear in the wild.
 */
export function parseHeaderPairs(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const colon = value.indexOf(":");
    const eq = value.indexOf("=");
    // Whichever separator comes FIRST wins, so `Authorization: Bearer a=b` keeps
    // the `=` inside the value instead of splitting on it.
    const at = colon >= 0 && (eq < 0 || colon < eq) ? colon : eq;
    if (at <= 0) throw new CmError(`Invalid --header "${value}" — expected "Key: Value".`);
    out[value.slice(0, at).trim()] = value.slice(at + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------- transport */

/**
 * Build a manifest transport from parsed `dispatch mcp add` flags.
 *
 * The transport is inferred the way `claude mcp add` infers it: an explicit
 * `--transport` wins; otherwise a `--url` means http and anything else means
 * stdio. The stdio command comes from post-`--` argv (preferred — it needs no
 * quoting gymnastics) or from `--command` plus the remaining positionals.
 *
 * Note that the `--command` form can only carry NON-flag-like args: the parser
 * stays strict so a mistyped `--fore` surfaces as an error instead of silently
 * becoming a server argument. Anything with a `-y`-shaped arg wants the `--`
 * form, which is also what every upstream README shows.
 */
export function transportFromArgs(args: ParsedArgs, positionalsAfterName: string[]): ManifestMcpTransport {
  const declared = flag(args, "transport");
  const url = flag(args, "url");
  if (declared && !["stdio", "http", "sse"].includes(declared)) {
    throw new CmError(`Unknown --transport "${declared}" — expected stdio, http, or sse.`);
  }
  const kind = declared ?? (url ? "http" : "stdio");

  if (kind === "http" || kind === "sse") {
    if (!url) throw new CmError(`--transport ${kind} requires --url.`);
    assertUrl(url);
    const headers = parseHeaderPairs(all(args, "header"));
    return ManifestMcpTransportSchema.parse({
      type: kind,
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }

  // stdio: `-- npx -y pkg` is the canonical form; `--command npx pkg` also works.
  const explicit = flag(args, "command");
  const argv = args.rest.length ? args.rest : explicit ? [explicit, ...positionalsAfterName] : [];
  const command = argv[0];
  if (!command) {
    throw new CmError(
      "No command given. Use `dispatch mcp add <name> -- <command> [args...]` for a stdio server, " +
        "or `--transport http --url <url>` for a remote one.",
    );
  }
  const env = parseEnvPairs(all(args, "env"));
  return ManifestMcpTransportSchema.parse({
    type: "stdio",
    command,
    ...(argv.length > 1 ? { args: argv.slice(1) } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  });
}

/** Reject a URL that won't connect, before it lands in a committed file. */
function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CmError(`--url "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CmError(`--url must be http(s), got "${parsed.protocol}".`);
  }
}
