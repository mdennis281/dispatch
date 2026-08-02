import { describe, it, expect } from "vitest";
import {
  expandEnvVars,
  expandEnvRecord,
  expandEnvList,
  referencedEnvVars,
} from "./env-expand.js";

const env = { TOKEN: "s3cret", EMPTY: "", REGION: "eu-west-1" };

describe("expandEnvVars", () => {
  it("substitutes ${VAR} from the supplied environment", () => {
    expect(expandEnvVars("Bearer ${TOKEN}", { env })).toBe("Bearer s3cret");
  });

  it("substitutes every occurrence in one string", () => {
    expect(expandEnvVars("${REGION}/${REGION}", { env })).toBe("eu-west-1/eu-west-1");
  });

  it("falls back to ${VAR:-default} when unset OR empty", () => {
    expect(expandEnvVars("${NOPE:-us-east-1}", { env })).toBe("us-east-1");
    expect(expandEnvVars("${EMPTY:-fallback}", { env })).toBe("fallback");
  });

  it("expands an unset variable to empty and reports it", () => {
    const missing: string[] = [];
    expect(expandEnvVars("k=${NOPE}", { env, onMissing: (n) => missing.push(n) })).toBe("k=");
    expect(missing).toEqual(["NOPE"]);
  });

  it("does not report a variable that had a default", () => {
    const missing: string[] = [];
    expandEnvVars("${NOPE:-x}", { env, onMissing: (n) => missing.push(n) });
    expect(missing).toEqual([]);
  });

  it("leaves bare $VAR alone — only braced placeholders expand", () => {
    expect(expandEnvVars("cost is $TOKEN and $5", { env })).toBe("cost is $TOKEN and $5");
  });

  it("leaves a malformed placeholder untouched", () => {
    expect(expandEnvVars("${not-an-ident}", { env })).toBe("${not-an-ident}");
    expect(expandEnvVars("${", { env })).toBe("${");
  });

  it("treats an absent process env as simply having no variables", () => {
    // The browser bundle path: no throw, no expansion.
    expect(expandEnvVars("${TOKEN}", { env: {} })).toBe("");
  });
});

describe("expandEnvRecord / expandEnvList", () => {
  it("expands values but never keys", () => {
    expect(expandEnvRecord({ "X-${TOKEN}": "${TOKEN}" }, { env })).toEqual({
      "X-${TOKEN}": "s3cret",
    });
  });

  it("passes undefined through", () => {
    expect(expandEnvRecord(undefined, { env })).toBeUndefined();
    expect(expandEnvList(undefined, { env })).toBeUndefined();
  });

  it("expands each element of a list", () => {
    expect(expandEnvList(["--region", "${REGION}"], { env })).toEqual(["--region", "eu-west-1"]);
  });
});

describe("referencedEnvVars", () => {
  it("collects distinct placeholder names, including defaulted ones", () => {
    expect(referencedEnvVars("${A} ${B:-x} ${A}").sort()).toEqual(["A", "B"]);
  });

  it("returns nothing for a plain string", () => {
    expect(referencedEnvVars("no placeholders $HERE")).toEqual([]);
  });
});
