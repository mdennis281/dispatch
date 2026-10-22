import { describe, expect, it } from "vitest";
import { coerceNumber, displayValue, fieldsFromSchema } from "./pluginSettingsForm.js";

describe("fieldsFromSchema", () => {
  it("renders strings, numbers, integers, booleans and enums, in schema order", () => {
    const { fields, unsupported } = fieldsFromSchema({
      type: "object",
      properties: {
        greeting: { type: "string", title: "Greeting", description: "What to say", default: "hello" },
        shout: { type: "boolean", default: false },
        repeat: { type: "integer", minimum: 1, maximum: 5, default: 1 },
        ratio: { type: "number" },
        tone: { type: "string", enum: ["friendly", "formal"], default: "friendly" },
        notes: { type: "string", format: "multiline" },
        optional: { type: ["string", "null"] },
      },
    });
    expect(unsupported).toEqual([]);
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ["greeting", "string"],
      ["shout", "boolean"],
      ["repeat", "integer"],
      ["ratio", "number"],
      ["tone", "enum"],
      ["notes", "string"],
      ["optional", "string"],
    ]);
    expect(fields[0]).toEqual({ key: "greeting", label: "Greeting", description: "What to say", kind: "string", default: "hello" });
    expect(fields[2]).toMatchObject({ minimum: 1, maximum: 5, default: 1 });
    expect(fields[4]!.options).toEqual(["friendly", "formal"]);
    expect(fields[5]!.multiline).toBe(true);
  });

  it("names what it cannot render instead of dropping it", () => {
    const { fields, unsupported } = fieldsFromSchema({
      properties: {
        ok: { type: "string" },
        nested: { type: "object", properties: { a: { type: "string" } } },
        list: { type: "array", items: { type: "string" } },
        mixedEnum: { enum: ["a", 1] },
        untyped: {},
      },
    });
    expect(fields.map((f) => f.key)).toEqual(["ok"]);
    expect(unsupported).toEqual(["nested", "list", "mixedEnum", "untyped"]);
  });

  it("is empty, not a crash, for a schema that is not an object schema", () => {
    expect(fieldsFromSchema(undefined)).toEqual({ fields: [], unsupported: [] });
    expect(fieldsFromSchema({ type: "string" })).toEqual({ fields: [], unsupported: [] });
    expect(fieldsFromSchema("nope")).toEqual({ fields: [], unsupported: [] });
  });
});

describe("coerceNumber", () => {
  it("clears on blank, parses when whole, and keeps a half-typed value as text", () => {
    expect(coerceNumber("integer", "")).toBeUndefined();
    expect(coerceNumber("integer", "3")).toBe(3);
    expect(coerceNumber("number", "1.5")).toBe(1.5);
    expect(coerceNumber("integer", "1.5")).toBe("1.5");
    expect(coerceNumber("number", "-")).toBe("-");
  });
});

describe("displayValue", () => {
  it("prefers the stored value, then the default", () => {
    const f = { key: "x", label: "x", kind: "string" as const, default: "d" };
    expect(displayValue(f, "s")).toBe("s");
    expect(displayValue(f, undefined)).toBe("d");
    expect(displayValue({ ...f, default: undefined }, undefined)).toBeUndefined();
  });
});
