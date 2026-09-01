import { beforeEach, describe, expect, it, vi } from "vitest";
import { leaseImagePreview } from "./imagePreview.js";

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:preview/1");
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe("leaseImagePreview", () => {
  it("releases the retained Blob URL exactly once when the preview closes", () => {
    const lease = leaseImagePreview(new Blob(["image bytes"]));
    expect(lease.src).toBe("blob:preview/1");

    lease.dispose();
    lease.dispose();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview/1");
  });
});
