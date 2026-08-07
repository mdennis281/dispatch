import { describe, it, expect } from "vitest";
import {
  fileUrlToPath,
  looksLikePath,
  pathsFromDataTransfer,
  pathsFromDrop,
  dropIntent,
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

describe("pathsFromDrop", () => {
  it("reads the text flavors a path-aware drag source publishes", () => {
    const d = drag({ data: { "text/uri-list": "file:///C:/repo/a.ts" } });
    expect(pathsFromDrop(d)).toEqual(["C:/repo/a.ts"]);
  });

  /**
   * The Electron preload used to place these exactly via `webUtils`. Without it
   * an Explorer drag carries content and a basename and nothing else, so the
   * caller's project-index lookup is the only remaining route to a path.
   */
  it("discloses nothing for a file drag that publishes no text flavor", () => {
    const files = [{ name: "a.ts" }, { name: "b.ts" }] as unknown as File[];
    expect(pathsFromDrop(drag({ files }))).toEqual([]);
  });
});

describe("dropIntent", () => {
  const fileItem = { kind: "file", type: "text/typescript" };
  const imageItem = { kind: "file", type: "image/png" };

  it("promises only a lookup for a plain file drag", () => {
    // An Explorer drag publishes no text flavor, so this really can't do better
    // than guess from the basename — and the overlay says so rather than
    // promising a path it won't deliver.
    expect(dropIntent(drag({ types: ["Files"], items: [fileItem] }))).toBe("lookup");
  });

  it("promises a path when the source volunteered a URI list", () => {
    expect(dropIntent(drag({ types: ["Files", "text/uri-list"], items: [fileItem] }))).toBe(
      "path",
    );
  });

  it("promises an attachment for images", () => {
    expect(dropIntent(drag({ types: ["Files"], items: [imageItem] }))).toBe("image");
  });

  it("calls a mixed drop an image drop, matching what handleDrop actually does", () => {
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
