/**
 * env-expand — `${VAR}` substitution for values authored in a COMMITTABLE config.
 *
 * `.claude-manager/project.yaml` is checked into the repo, so an MCP server that
 * needs an API key must not carry the key itself. Instead it carries a
 * placeholder, and the manager substitutes the real value from its own process
 * environment when it launches a session:
 *
 *     env:
 *       LINEAR_API_KEY: ${LINEAR_API_KEY}
 *       REGION: ${AWS_REGION:-us-east-1}
 *
 * Syntax is the familiar POSIX subset — `${VAR}` and `${VAR:-default}` — and
 * nothing else. Bare `$VAR` is deliberately NOT expanded: unbraced `$` shows up
 * constantly in real commands and prices, and silently eating it would be worse
 * than making the config explicit. An unset variable with no default expands to
 * the empty string rather than throwing, so one missing key can't stop a whole
 * project's sessions from starting; callers that care can pass an `onMissing`
 * hook to surface it as a config warning.
 */

/** `${NAME}` or `${NAME:-default}` — NAME is a conventional env identifier. */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Options for {@link expandEnvVars}. */
export interface ExpandOptions {
  /** The variable source. Defaults to the ambient process env (empty in a browser). */
  env?: Record<string, string | undefined>;
  /** Called once per placeholder that resolved to nothing and had no default. */
  onMissing?: (name: string) => void;
}

/**
 * The ambient environment, read defensively. `@cm/shared` is bundled into the
 * BROWSER client as well as the server, and a bare `process.env` reference would
 * either fail to type-check without `@types/node` or blow up at runtime in a
 * bundle that doesn't shim it. On the client there are no vars to expand anyway,
 * so an empty record is the correct fallback.
 */
function ambientEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/** Expand every `${VAR}` / `${VAR:-default}` placeholder in one string. */
export function expandEnvVars(value: string, opts: ExpandOptions = {}): string {
  const env = opts.env ?? ambientEnv();
  return value.replace(PLACEHOLDER_RE, (_match, name: string, fallback?: string) => {
    const found = env[name];
    if (found !== undefined && found !== "") return found;
    if (fallback !== undefined) return fallback;
    opts.onMissing?.(name);
    return "";
  });
}

/** Expand every value of a `Record<string, string>`, leaving keys untouched. */
export function expandEnvRecord(
  record: Record<string, string> | undefined,
  opts: ExpandOptions = {},
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) out[key] = expandEnvVars(value, opts);
  return out;
}

/** Expand every element of a string array (an MCP server's `args`). */
export function expandEnvList(
  list: string[] | undefined,
  opts: ExpandOptions = {},
): string[] | undefined {
  return list?.map((v) => expandEnvVars(v, opts));
}

/** Every distinct placeholder name referenced by a string (for diagnostics). */
export function referencedEnvVars(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}
