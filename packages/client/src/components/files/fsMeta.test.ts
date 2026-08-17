import { describe, it, expect } from "vitest";
import { File, FileCode, FileImage, Folder, FolderGit2, Link2Off } from "lucide-react";
import {
  entryIcon,
  formatBytes,
  formatStamp,
  formatCapacity,
  describeFilter,
} from "./fsMeta.js";
import type { FsEntry } from "@dispatch/shared";

const entry = (over: Partial<FsEntry> & { name: string }): FsEntry => ({
  path: `/x/${over.name}`,
  kind: "file",
  size: 0,
  modifiedAt: 0,
  createdAt: null,
  accessedAt: null,
  ext: over.name.includes(".") ? (over.name.split(".").pop() ?? "") : "",
  hidden: false,
  ...over,
});

describe("entryIcon", () => {
  it("groups code by what it IS, not by language", () => {
    expect(entryIcon(entry({ name: "a.ts" }))).toBe(FileCode);
    expect(entryIcon(entry({ name: "b.py" }))).toBe(FileCode);
  });

  it("recognizes images and falls back to a plain file", () => {
    expect(entryIcon(entry({ name: "a.png" }))).toBe(FileImage);
    expect(entryIcon(entry({ name: "a.unknownext" }))).toBe(File);
    expect(entryIcon(entry({ name: "Makefile" }))).toBe(File);
  });

  it("gives .git its own icon", () => {
    expect(entryIcon(entry({ name: ".git", kind: "directory", ext: "" }))).toBe(FolderGit2);
    expect(entryIcon(entry({ name: "src", kind: "directory", ext: "" }))).toBe(Folder);
  });

  it("shows a broken link as broken, whatever it is named", () => {
    // The name still looks like an ordinary file; only the icon can say.
    const dangling = entry({ name: "photo.png", link: { target: "gone", broken: true } });
    expect(entryIcon(dangling)).toBe(Link2Off);
  });
});

describe("formatBytes", () => {
  it("uses bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(840)).toBe("840 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up through the units at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("keeps one decimal below 10 and drops it above", () => {
    // Rounding 1.9 GB to "2 GB" loses the distinction the column exists for.
    expect(formatBytes(Math.round(1.9 * 1024 ** 3))).toBe("1.9 GB");
    expect(formatBytes(Math.round(120.4 * 1024 ** 2))).toBe("120 MB");
  });

  it("renders an unknown size as a dash, not as zero", () => {
    // A permission-denied file has no size; "0 B" would be a claim.
    expect(formatBytes(null)).toBe("—");
  });

  it("caps at the largest unit instead of inventing one", () => {
    expect(formatBytes(1024 ** 6)).toContain("PB");
  });
});

describe("formatStamp", () => {
  const now = new Date("2026-08-17T14:30:00").getTime();

  it("shows a clock for today", () => {
    const today = new Date("2026-08-17T09:05:00").getTime();
    expect(formatStamp(today, now)).toMatch(/\d{1,2}:\d{2}/);
  });

  it("shows day and month for earlier this year, with no year", () => {
    const stamp = formatStamp(new Date("2026-03-02T09:05:00").getTime(), now);
    expect(stamp).not.toMatch(/2026/);
    expect(stamp).toMatch(/2/);
  });

  it("shows the year for anything older", () => {
    expect(formatStamp(new Date("2024-03-02T09:05:00").getTime(), now)).toMatch(/2024/);
  });

  it("renders an unknown time as a dash", () => {
    expect(formatStamp(null, now)).toBe("—");
  });
});

describe("formatCapacity", () => {
  it("reads as free-of-total", () => {
    expect(formatCapacity(1024 ** 3, 4 * 1024 ** 3)).toBe("1.0 GB free of 4.0 GB");
  });

  it("says nothing when the volume couldn't be measured", () => {
    // A network share that didn't answer `statfs` gets no capacity line at all,
    // rather than "0 B free" — which reads as a full disk.
    expect(formatCapacity(null, null)).toBeNull();
    expect(formatCapacity(5, 0)).toBeNull();
    expect(formatCapacity(undefined, undefined)).toBeNull();
  });
});

describe("describeFilter", () => {
  it("names the shape being asked for", () => {
    expect(describeFilter({ select: "file", multiple: false })).toBe("Choose a file");
    expect(describeFilter({ select: "directory", multiple: false })).toBe("Choose a folder");
    expect(describeFilter({ select: "any", multiple: false })).toBe("Choose a file or folder");
  });

  it("pluralizes for a multi-select", () => {
    expect(describeFilter({ select: "file", multiple: true })).toBe(
      "Choose one or more files",
    );
    expect(describeFilter({ select: "directory", multiple: true })).toBe(
      "Choose one or more folders",
    );
  });

  it("lists the acceptable extensions", () => {
    expect(describeFilter({ select: "file", extensions: ["png"], multiple: false })).toBe(
      "Choose a PNG file",
    );
    expect(
      describeFilter({ select: "file", extensions: ["png", "jpg"], multiple: false }),
    ).toBe("Choose a PNG or JPG file");
    expect(
      describeFilter({ select: "file", extensions: ["png", "jpg", "gif"], multiple: true }),
    ).toBe("Choose one or more PNG, JPG or GIF files");
  });

  it("ignores extensions for a folder picker, which has no use for them", () => {
    expect(
      describeFilter({ select: "directory", extensions: ["png"], multiple: false }),
    ).toBe("Choose a folder");
  });

  it("ignores an empty extension list", () => {
    expect(describeFilter({ select: "file", extensions: [], multiple: false })).toBe(
      "Choose a file",
    );
  });
});
