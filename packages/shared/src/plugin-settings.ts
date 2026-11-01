/**
 * A plugin's settings blob (`AppSettings.plugins[id].settings`): the one patch
 * rule every writer applies, and validation against the plugin's
 * `settings.schema.json`.
 *
 * Three writers share these — the Settings pane's form, the plugin's server
 * half (`ctx.settings.set`) and its browser half (`host.settings.set`) — and
 * they write CONCURRENTLY: a plugin can store a paired machine while the owner
 * has the form open. So a write is a PATCH of the keys it means to change,
 * never a whole-object replace built from a copy that may be stale.
 *
 * VALIDATION never blocks a write over a key the write did not touch. A plugin
 * that grows a schema (or tightens one) in an update finds settings stored
 * before it existed; refusing every later save until someone hand-edits
 * config.json would turn a schema into an outage. So:
 *
 *   - an error on a key this write CHANGED refuses the write;
 *   - an error on a key it left alone is "standing" — reported on the plugin's
 *     row (`PluginInfo.settingsErrors`), never a reason to refuse.
 *
 * The schema is compiled with zod's `fromJSONSchema`, which covers the JSON
 * Schema a settings file realistically uses (types, enums, ranges, patterns,
 * arrays of objects, `required`, `additionalProperties`, `$ref`). A schema it
 * cannot compile (`if`/`then`, say) is not enforced at all: the row says so,
 * and writes are stored unchecked — the same as before validation existed.
 */
import * as z from "zod";

export type PluginSettings = Record<string, unknown>;

/**
 * Apply a top-level merge patch: each key in `patch` replaces the stored value
 * wholesale (an object or array is not merged into), and a key set to `null`
 * or `undefined` is removed. RFC 7396 at one level — deep merging a host list
 * would make "remove this host" inexpressible.
 */
export function applySettingsPatch(current: PluginSettings, patch: PluginSettings): PluginSettings {
  const next: PluginSettings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** Structural equality for JSON values, key order ignored — what "did this key change" means. */
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** A compiled settings schema, or why there is none to enforce. */
export type CompiledSettingsSchema =
  | { ok: true; check(value: PluginSettings): Array<{ key: string; message: string }> }
  | { ok: false; reason: string };

/**
 * Compile a plugin's settings JSON Schema. Two normalisations before zod sees
 * it, both for schemas plugins already ship:
 *
 *   - a root with `properties` but no `type` is an object schema. JSON Schema
 *     applies `properties` regardless, but zod's converter ignores them
 *     without `type: "object"`, which would accept anything.
 *   - `definitions` / `#/definitions/…` without a draft-07 `$schema` are
 *     retried as the 2020-12 `$defs` the converter resolves by default.
 */
export function compilePluginSettingsSchema(schema: unknown): CompiledSettingsSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: false, reason: "the settings schema is not a JSON object" };
  }
  let normalised = schema as Record<string, unknown>;
  if (normalised.properties !== undefined && normalised.type === undefined) normalised = { ...normalised, type: "object" };
  const attempts = [normalised];
  // The converter resolves `definitions` only when `$schema` names draft-07;
  // a schema that uses them without saying so gets a 2020-12 retry.
  if (normalised.definitions !== undefined && normalised.$defs === undefined) {
    const { $schema: _dialect, definitions, ...rest } = JSON.parse(
      JSON.stringify(normalised).replace(/"#\/definitions\//g, '"#/$defs/'),
    ) as Record<string, unknown>;
    attempts.push({ ...rest, $defs: definitions });
  }
  let compiled: z.ZodType | undefined;
  let reason = "";
  for (const attempt of attempts) {
    try {
      compiled = z.fromJSONSchema(attempt as Parameters<typeof z.fromJSONSchema>[0]);
      break;
    } catch (err) {
      reason ||= err instanceof Error ? err.message : String(err);
    }
  }
  if (!compiled) return { ok: false, reason };
  const schemaOf = compiled;
  return {
    ok: true,
    check: (value) => {
      const r = schemaOf.safeParse(value);
      if (r.success) return [];
      const out: Array<{ key: string; message: string }> = [];
      for (const issue of r.error.issues) {
        // `additionalProperties: false` reports on the OBJECT, naming the keys:
        // at the root each is a setting of its own; deeper (an item in a host
        // list) it belongs to the top-level key that object sits under.
        if (issue.code === "unrecognized_keys" && !issue.path.length) {
          for (const key of issue.keys) out.push({ key, message: `${key}: not a setting this plugin declares` });
          continue;
        }
        const key = issue.path.length ? String(issue.path[0]) : "";
        out.push({ key, message: `${issue.path.length ? issue.path.join(".") : "(settings)"}: ${issue.message}` });
      }
      return out;
    },
  };
}

/**
 * Judge a write: `refused` holds the errors on keys whose value differs
 * between `prev` and `next` (plus any root-level error), `standing` the rest.
 */
export function checkPluginSettings(
  compiled: CompiledSettingsSchema | undefined,
  prev: PluginSettings,
  next: PluginSettings,
): { refused: string[]; standing: string[] } {
  if (!compiled?.ok) return { refused: [], standing: [] };
  const refused: string[] = [];
  const standing: string[] = [];
  for (const { key, message } of compiled.check(next)) {
    if (key === "" || !sameSettingsValue(prev[key], next[key])) refused.push(message);
    else standing.push(message);
  }
  return { refused, standing };
}
