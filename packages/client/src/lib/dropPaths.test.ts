import { describe, it, expect, afterEach } from "vitest";
import {
  fileUrlToPath,
  looksLikePath,
  pathsFromDataTransfer,
  pathsFromFiles,
  pathsFromDrop,
  dropIntent,
  isDesktop,
  basenameOf,
} from "./dropPaths.js";

/** Minimal DataTransfer stand-in: only what the extractor actually reads. */
function dt(data: Record<string, string>, opts: { throwOn?: string } = {}): DataTransfer {
  return {
    getData: (type: string) => {
      if (type === opts.throwOn) throw new Error("protected drag source");
      return data[type] ?? "";
    },
  } as unknown as DataTransfer;
}

/**
 * A drag as `dragover` sees it: `types` and each item's kind/type are readable,
 * the payload is not. `files` is populated only for the `drop` phase cases.
 */
function drag(opts: {
  types?: string[];
  items?: { kind: string; type: string }[];
  files?: { name: string }[];
  data?: Record<string, string>;
}): DataTransfer {
  const data = opts.data ?? {};
  return {
    types: opts.types ?? [],
    items: opts.items ?? [],
    files: opts.files ?? [],
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

/** Install the preload bridge for one test. */
function withDesktop(paths: Record<string, string>) {
  (globalThis as { window?: unknown }).window = {
    cmDesktop: { getPathForFile: (f: File) => paths[f.name] ?? "" },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("fileUrlToPath", () => {
  it("decodes a POSIX file URI", () => {
    expect(fileUrlToPath("file:///home/mike/src/app.ts")).toBe("/home/mike/src/app.ts");
  });

  it("strips the URI's leading slash before a Windows drive letter", () => {
    // `file:///C:/x` is a correct URI whose path component (`/C:/x`) is not a
    // usable Windows path — this is the whole reason the function exists.
    expect(fileUrlToPath("file:///C:/Users/Michael/a.ts")).toBe("C:/Users/Michael/a.ts");
  });

  it("percent-decodes spaces and other escapes", () => {
    expect(fileUrlToPath("file:///c:/My%20Docs/a%20b.ts")).toBe("c:/My Docs/a b.ts");
  });

  it("keeps a malformed escape rather than throwing", () => {
    expect(fileUrlToPath("file:///tmp/100%")).toBe("/tmp/100%");
  });

  it("turns a host-bearing URI into a UNC path", () => {
    expect(fileUrlToPath("file://server/share/a.ts")).toBe("\\\\server\\share\\a.ts");
  });

  it("rejects anything that isn't a file URI", () => {
    expect(fileUrlToPath("https://example.com/a.ts")).toBeNull();
    expect(fileUrlToPath("/home/mike/a.ts")).toBeNull();
  });
});

describe("looksLikePath", () => {
  it("accepts absolute POSIX, Windows and UNC forms", () => {
    expect(looksLikePath("/home/mike/a.ts")).toBe(true);
    expect(looksLikePath("C:\\Users\\Michael\\a.ts")).toBe(true);
    expect(looksLikePath("c:/users/michael/a.ts")).toBe(true);
    expect(looksLikePath("\\\\server\\share\\a.ts")).toBe(true);
  });

  it("rejects relative names and prose — a bare word is more likely text", () => {
    expect(looksLikePath("a.ts")).toBe(false);
    expect(looksLikePath("src/a.ts")).toBe(false);
    expect(looksLikePath("look at the file")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });

  it("rejects multi-line text (a paste, not a path)", () => {
    expect(looksLikePath("/home/a.ts\n/home/b.ts")).toBe(false);
  });
});

describe("pathsFromDataTransfer", () => {
  it("prefers text/uri-list and skips its comment lines", () => {
    const paths = pathsFromDataTransfer(
      dt({ "text/uri-list": "# comment\nfile:///home/a.ts\nfile:///home/b.ts" }),
    );
    expect(paths).toEqual(["/home/a.ts", "/home/b.ts"]);
  });

  it("dedupes a uri-list that repeats a path", () => {
    const paths = pathsFromDataTransfer(
      dt({ "text/uri-list": "file:///home/a.ts\nfile:///home/a.ts" }),
    );
    expect(paths).toEqual(["/home/a.ts"]);
  });

  it("falls back to text/plain — what VS Code and terminals actually send", () => {
    expect(pathsFromDataTransfer(dt({ "text/plain": "C:\\repo\\src\\a.ts" }))).toEqual([
      "C:\\repo\\src\\a.ts",
    ]);
  });

  it("accepts a file URI arriving via text/plain", () => {
    expect(pathsFromDataTransfer(dt({ "text/plain": "file:///home/a.ts" }))).toEqual([
      "/home/a.ts",
    ]);
  });

  it("returns nothing for a content-only drop (the file-manager case)", () => {
    // The OS drag carries the file's bytes and a basename, no path — the caller
    // has to fall back to resolving the name against the project index.
    expect(pathsFromDataTransfer(dt({}))).toEqual([]);
    expect(pathsFromDataTransfer(dt({ "text/plain": "a.ts" }))).toEqual([]);
  });

  it("ignores non-file URIs (dragging a link is not dragging a file)", () => {
    expect(pathsFromDataTransfer(dt({ "text/uri-list": "https://example.com/a.ts" }))).toEqual(
      [],
    );
  });

  it("survives a getData that throws on a protected drag source", () => {
    expect(() =>
      pathsFromDataTransfer(dt({ "text/plain": "/home/a.ts" }, { throwOn: "text/uri-list" })),
    ).not.toThrow();
    expect(
      pathsFromDataTransfer(dt({ "text/plain": "/home/a.ts" }, { throwOn: "text/uri-list" })),
    ).toEqual(["/home/a.ts"]);
  });

  it("handles a null dataTransfer", () => {
    expect(pathsFromDataTransfer(null)).toEqual([]);
  });
});

describe("the Electron bridge", () => {
  const files = [{ name: "a.ts" }, { name: "b.ts" }] as unknown as File[];

  it("is absent in a browser, so file drops disclose nothing", () => {
    expect(isDesktop()).toBe(false);
    expect(pathsFromFiles(drag({ files }))).toEqual([]);
  });

  it("resolves every dropped file to its real path", () => {
    withDesktop({ "a.ts": "C:\\repo\\a.ts", "b.ts": "C:\\repo\\sub\\b.ts" });
    expect(isDesktop()).toBe(true);
    expect(pathsFromFiles(drag({ files }))).toEqual(["C:\\repo\\a.ts", "C:\\repo\\sub\\b.ts"]);
  });

  it("skips files it can't place rather than emitting blanks", () => {
    // A File the OS never put on disk (synthesized by a paste) resolves to "".
    withDesktop({ "a.ts": "C:\\repo\\a.ts" });
    expect(pathsFromFiles(drag({ files }))).toEqual(["C:\\repo\\a.ts"]);
  });

  it("dedupes the same file dropped twice", () => {
    withDesktop({ "a.ts": "C:\\repo\\a.ts" });
    const twice = [{ name: "a.ts" }, { name: "a.ts" }] as unknown as File[];
    expect(pathsFromFiles(drag({ files: twice }))).toEqual(["C:\\repo\\a.ts"]);
  });

  it("wins over the text flavors, which the drag source composes by hand", () => {
    withDesktop({ "a.ts": "C:\\real\\a.ts" });
    const d = drag({
      files: [{ name: "a.ts" }],
      data: { "text/uri-list": "file:///C:/stale/a.ts" },
    });
    expect(pathsFromDrop(d)).toEqual(["C:\\real\\a.ts"]);
  });

  it("falls back to the text flavors when the bridge comes up empty", () => {
    withDesktop({});
    const d = drag({ data: { "text/uri-list": "file:///C:/repo/a.ts" } });
    expect(pathsFromDrop(d)).toEqual(["C:/repo/a.ts"]);
  });
});

describe("dropIntent", () => {
  const fileItem = { kind: "file", type: "text/typescript" };
  const imageItem = { kind: "file", type: "image/png" };

  it("promises a path for a plain file drag in the desktop shell", () => {
    withDesktop({});
    expect(dropIntent(drag({ types: ["Files"], items: [fileItem] }))).toBe("path");
  });

  it("promises only a lookup for the same drag in a browser", () => {
    // The whole point of the bridge: in a browser this drag really can't do
    // better than guess from the basename, and says so.
    expect(dropIntent(drag({ types: ["Files"], items: [fileItem] }))).toBe("lookup");
  });

  it("promises a path in a browser when the source volunteered a URI list", () => {
    expect(dropIntent(drag({ types: ["Files", "text/uri-list"], items: [fileItem] }))).toBe(
      "path",
    );
  });

  it("promises an attachment for images", () => {
    withDesktop({});
    expect(dropIntent(drag({ types: ["Files"], items: [imageItem] }))).toBe("image");
  });

  it("calls a mixed drop an image drop, matching what handleDrop actually does", () => {
    withDesktop({});
    expect(dropIntent(drag({ types: ["Files"], items: [imageItem, fileItem] }))).toBe("image");
  });

  it("promises a path for a fileless URI drag (a VS Code tab, a terminal)", () => {
    expect(dropIntent(drag({ types: ["text/uri-list"] }))).toBe("path");
  });

  it("ignores a text selection — a dragged word is prose, not a file", () => {
    expect(dropIntent(drag({ types: ["text/plain"] }))).toBeNull();
    expect(dropIntent(null)).toBeNull();
  });

  it("survives a host that exposes no types at all", () => {
    expect(dropIntent(drag({}))).toBeNull();
  });
});

describe("basenameOf", () => {
  it("takes the filename for either separator", () => {
    expect(basenameOf("C:\\repo\\src\\a.ts")).toBe("a.ts");
    expect(basenameOf("/home/mike/a.ts")).toBe("a.ts");
    expect(basenameOf("a.ts")).toBe("a.ts");
  });
});
