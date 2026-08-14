import { describe, expect, it } from "vitest";
import { statusMeta } from "./StatusDot.js";

describe("statusMeta", () => {
  it("uses blue for waits and red for unsuccessful exits", () => {
    expect(statusMeta("waiting")).toMatchObject({ tone: "info", label: "Waiting" });
    expect(statusMeta("failed")).toMatchObject({ tone: "danger", label: "Failed" });
    expect(statusMeta("error")).toMatchObject({ tone: "danger", label: "Error" });
  });
});
