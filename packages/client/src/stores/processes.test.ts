import { describe, it, expect, vi, beforeEach } from "vitest";

const list = vi.fn();
vi.mock("../lib/api.js", () => ({ api: { processes: { list: (id: string) => list(id) } } }));

const { useProcesses } = await import("./processes.js");

const row = (port: number, tracked: boolean) => ({ port, pid: port, tracked });

beforeEach(() => {
  list.mockReset();
  useProcesses.setState({ byProject: {}, scanning: {}, errors: {} });
});

describe("processes store", () => {
  it("holds a project's rows so the orphan count exists before anything is expanded", async () => {
    list.mockResolvedValue([row(5173, true), row(5174, false), row(2567, false)]);

    await useProcesses.getState().scan("p1");

    const rows = useProcesses.getState().byProject["p1"]!;
    expect(rows.filter((r) => !r.tracked)).toHaveLength(2);
  });

  it("coalesces concurrent scans of one project into a single OS scan", async () => {
    list.mockResolvedValue([]);

    // A project switch and a panel expand can fire in the same tick; the scan
    // shells out to netstat, so the second must ride the first.
    await Promise.all([
      useProcesses.getState().scan("p1"),
      useProcesses.getState().scan("p1"),
    ]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(useProcesses.getState().scanning["p1"]).toBe(false);
  });

  it("scans again after the previous one settles", async () => {
    list.mockResolvedValue([]);
    await useProcesses.getState().scan("p1");
    await useProcesses.getState().scan("p1");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("records a failure per project instead of throwing at the caller", async () => {
    list.mockRejectedValue(new Error("netstat exploded"));

    await expect(useProcesses.getState().scan("p1")).resolves.toBeUndefined();

    expect(useProcesses.getState().errors["p1"]).toBe("netstat exploded");
    expect(useProcesses.getState().scanning["p1"]).toBe(false);
  });

  it("keeps projects independent", async () => {
    list.mockImplementation((id: string) => Promise.resolve(id === "p1" ? [row(5173, false)] : []));

    await useProcesses.getState().scan("p1");
    await useProcesses.getState().scan("p2");

    expect(useProcesses.getState().byProject["p1"]).toHaveLength(1);
    expect(useProcesses.getState().byProject["p2"]).toHaveLength(0);
  });
});
