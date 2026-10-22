/**
 * The generic settings form, derived from a plugin's JSON Schema.
 *
 * Deliberately a SUBSET of JSON Schema — flat objects of strings, numbers,
 * integers, booleans and enums — because that is what a settings pane can
 * render as a row per key, and what every plugin's settings actually are. A
 * property the subset cannot express is listed by name rather than dropped
 * silently, so the owner knows to edit it in config.json instead of concluding
 * the plugin has no such setting. Pure, so it is testable without the DOM.
 */

export type SettingsFieldKind = "string" | "number" | "integer" | "boolean" | "enum";

export interface SettingsField {
  key: string;
  label: string;
  description?: string;
  kind: SettingsFieldKind;
  /** `enum` only. */
  options?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** `string` only: the schema asked for a multi-line value (`format: multiline` or `maxLength` > 200). */
  multiline?: boolean;
}

export interface SettingsForm {
  fields: SettingsField[];
  /** Property names the subset cannot render (objects, arrays, unions). */
  unsupported: string[];
}

interface SchemaProperty {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  format?: string;
}

function scalarType(p: SchemaProperty): string | undefined {
  // `["string", "null"]` is the common way to say optional; the non-null type
  // is what the field renders.
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== "null") : p.type;
  return typeof t === "string" ? t : undefined;
}

export function fieldsFromSchema(schema: unknown): SettingsForm {
  const out: SettingsForm = { fields: [], unsupported: [] };
  if (!schema || typeof schema !== "object") return out;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return out;
  for (const [key, raw] of Object.entries(props)) {
    const p = (raw && typeof raw === "object" ? raw : {}) as SchemaProperty;
    const base = {
      key,
      label: p.title ?? key,
      ...(p.description ? { description: p.description } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
    };
    if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
      out.fields.push({ ...base, kind: "enum", options: p.enum as string[] });
      continue;
    }
    const type = scalarType(p);
    if (type === "string") {
      const multiline = p.format === "multiline" || (p.maxLength ?? 0) > 200;
      out.fields.push({ ...base, kind: "string", ...(multiline ? { multiline } : {}) });
    } else if (type === "number" || type === "integer") {
      out.fields.push({
        ...base,
        kind: type,
        ...(typeof p.minimum === "number" ? { minimum: p.minimum } : {}),
        ...(typeof p.maximum === "number" ? { maximum: p.maximum } : {}),
      });
    } else if (type === "boolean") {
      out.fields.push({ ...base, kind: "boolean" });
    } else {
      out.unsupported.push(key);
    }
  }
  return out;
}

/**
 * What a text box's contents mean for a numeric field: a blank box clears the
 * key (back to the plugin's default) rather than storing `0` or `NaN`. A
 * half-typed `-` or `1.` stays a string until it parses, so the box doesn't
 * fight the keystroke.
 */
export function coerceNumber(kind: "number" | "integer", raw: string): number | undefined | string {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = kind === "integer" ? Number.parseInt(trimmed, 10) : Number(trimmed);
  if (!Number.isFinite(n)) return raw;
  if (kind === "integer" && String(n) !== trimmed) return raw;
  return n;
}

/** The value a field shows: stored, else the schema default, else empty. */
export function displayValue(field: SettingsField, stored: unknown): unknown {
  return stored !== undefined ? stored : field.default;
}
