import { describe, expect, it } from "vitest";
import { applySettingsPatch, checkPluginSettings, compilePluginSettingsSchema, sameSettingsValue } from "./plugin-settings.js";

describe("applySettingsPatch", () => {
  it("replaces each key wholesale and removes a key set to null or undefined", () => {
    const current = { hosts: [{ id: "a" }, { id: "b" }], label: "x", port: 22, nested: { a: 1, b: 2 } };
    expect(applySettingsPatch(current, { hosts: [{ id: "b" }], port: null, nested: { a: 3 }, extra: undefined, added: true })).toEqual({
      hosts: [{ id: "b" }],
      label: "x",
      nested: { a: 3 },
      added: true,
    });
    // Never mutates what it was given — that is the cached copy on the host.
    expect(current.port).toBe(22);
  });
});

describe("sameSettingsValue", () => {
  it("ignores key order and undefined members", () => {
    expect(sameSettingsValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1, e: undefined })).toBe(true);
    expect(sameSettingsValue([1, 2], [2, 1])).toBe(false);
    expect(sameSettingsValue(undefined, null)).toBe(false);
  });
});

describe("compilePluginSettingsSchema + checkPluginSettings", () => {
  const schema = {
    type: "object",
    properties: {
      port: { type: "integer", minimum: 1, maximum: 65535 },
      hosts: {
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z-]+$" } }, additionalProperties: false },
      },
    },
    additionalProperties: false,
  };

  it("refuses only errors on keys the write changed; the rest are standing", () => {
    const compiled = compilePluginSettingsSchema(schema);
    const prev = { port: "eighty" };
    expect(checkPluginSettings(compiled, prev, { port: "eighty", hosts: [{ id: "mac" }] })).toEqual({
      refused: [],
      standing: [expect.stringMatching(/^port: /)],
    });
    const r = checkPluginSettings(compiled, prev, { port: "eighty", hosts: [{ id: "Mac", extra: 1 }] });
    expect(r.refused.join("\n")).toMatch(/hosts\.0\.id/);
    expect(r.refused.join("\n")).toMatch(/hosts\.0/);
    expect(r.standing).toEqual([expect.stringMatching(/^port: /)]);
  });

  it("attributes additionalProperties: false to the keys it names", () => {
    const compiled = compilePluginSettingsSchema(schema);
    expect(checkPluginSettings(compiled, { stray: 1 }, { stray: 1, port: 1 })).toEqual({
      refused: [],
      standing: ["stray: not a setting this plugin declares"],
    });
    expect(checkPluginSettings(compiled, {}, { stray: 1 }).refused).toEqual(["stray: not a setting this plugin declares"]);
  });

  it("treats `properties` without `type` as an object schema, and resolves draft-07 definitions", () => {
    const untyped = compilePluginSettingsSchema({ properties: { a: { type: "boolean" } } });
    expect(checkPluginSettings(untyped, {}, { a: "nope" }).refused).toHaveLength(1);
    const draft07 = compilePluginSettingsSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { n: { $ref: "#/definitions/num" } },
      definitions: { num: { type: "number" } },
    });
    expect(draft07.ok).toBe(true);
    expect(checkPluginSettings(draft07, {}, { n: "x" }).refused).toHaveLength(1);
    expect(checkPluginSettings(draft07, {}, { n: 2 }).refused).toEqual([]);
    // The same `definitions` with no `$schema` saying draft-07.
    const undeclared = compilePluginSettingsSchema({ type: "object", properties: { n: { $ref: "#/definitions/num" } }, definitions: { num: { type: "number" } } });
    expect(checkPluginSettings(undeclared, {}, { n: "x" }).refused).toHaveLength(1);
  });

  it("enforces nothing when the schema cannot be compiled — and says why", () => {
    const compiled = compilePluginSettingsSchema({ type: "object", if: { properties: {} }, then: { required: ["a"] } });
    expect(compiled).toEqual({ ok: false, reason: expect.stringMatching(/if/i) });
    expect(checkPluginSettings(compiled, {}, { anything: 1 })).toEqual({ refused: [], standing: [] });
    expect(compilePluginSettingsSchema("nope")).toMatchObject({ ok: false });
    expect(checkPluginSettings(undefined, {}, { a: 1 })).toEqual({ refused: [], standing: [] });
  });
});
