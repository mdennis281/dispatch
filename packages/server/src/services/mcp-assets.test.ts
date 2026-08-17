import { describe, it, expect } from "vitest";
import { parseAssetReference, pathFromFileUri, isPathWithinRoots } from "./mcp-assets.js";
import { mediaKind, formatBytes } from "@dispatch/shared";
import { extFromMediaType, mediaTypeFromName } from "./media-types.js";

describe("pathFromFileUri", () => {
  it("percent-decodes, so a path with a space actually exists on disk", () => {
    expect(pathFromFileUri("file:///tmp/my%20clip.mp4")).toBe("/tmp/my clip.mp4");
  });

  it("drops the leading slash a Windows drive path arrives with", () => {
    expect(pathFromFileUri("file:///C:/runs/out.mp4")).toBe("C:/runs/out.mp4");
  });

  it("returns null for a non-file uri", () => {
    expect(pathFromFileUri("https://example.com/x.mp4")).toBeNull();
  });
});

describe("parseAssetReference", () => {
  it("reads a standard resource_link", () => {
    expect(
      parseAssetReference({
        type: "resource_link",
        uri: "file:///tmp/run.mp4",
        name: "run",
        mimeType: "video/mp4",
      }),
    ).toEqual({ path: "/tmp/run.mp4", alt: "run", mimeType: "video/mp4" });
  });

  it("accepts a bare path in a resource_link, but not a remote url", () => {
    expect(parseAssetReference({ type: "resource_link", uri: "out/run.mp4" })?.path).toBe(
      "out/run.mp4",
    );
    // A remote URL is not ours to copy off the filesystem.
    expect(parseAssetReference({ type: "resource_link", uri: "https://x/y.mp4" })).toBeNull();
  });

  it("reads a resource block that only points at a file", () => {
    expect(
      parseAssetReference({
        type: "resource",
        resource: { uri: "file:///tmp/a.webm", mimeType: "video/webm" },
      }),
    ).toEqual({ path: "/tmp/a.webm", alt: undefined, mimeType: "video/webm" });
  });

  it("ignores a resource whose payload is already INLINE", () => {
    // text/blob means the bytes are here; treating it as a reference would send
    // us looking for a file that was never written.
    expect(
      parseAssetReference({ type: "resource", resource: { uri: "file:///a", text: "hi" } }),
    ).toBeNull();
    expect(
      parseAssetReference({ type: "resource", resource: { uri: "file:///a", blob: "AA==" } }),
    ).toBeNull();
  });

  it("reads the dispatch envelope escape hatch", () => {
    expect(
      parseAssetReference({
        type: "text",
        text: '{"dispatch":"asset","path":"/tmp/x.mp4","alt":"demo"}',
      }),
    ).toEqual({ path: "/tmp/x.mp4", alt: "demo", mimeType: undefined });
  });

  it("leaves ordinary text and ordinary JSON alone", () => {
    expect(parseAssetReference({ type: "text", text: "just words" })).toBeNull();
    expect(parseAssetReference({ type: "text", text: '{"ok":true}' })).toBeNull();
    // Malformed JSON must not throw — it's just text.
    expect(parseAssetReference({ type: "text", text: '{"dispatch":' })).toBeNull();
  });

  it("ignores an image block, which the inline path already handles", () => {
    expect(parseAssetReference({ type: "image", data: "AA==", mimeType: "image/png" })).toBeNull();
  });

  it("is null-safe", () => {
    expect(parseAssetReference(null)).toBeNull();
    expect(parseAssetReference("nope")).toBeNull();
    expect(parseAssetReference(undefined)).toBeNull();
  });
});

describe("isPathWithinRoots", () => {
  // Platform-rooted: a literal "C:/…" is a RELATIVE path on the Linux runner.
  const ROOT = process.platform === "win32" ? "C:/wt" : "/wt";
  const TMP = process.platform === "win32" ? "C:/tmp" : "/tmp";
  const roots = [ROOT, TMP];

  it("allows the root itself and anything under it", () => {
    expect(isPathWithinRoots(ROOT, roots)).toBe(true);
    expect(isPathWithinRoots(`${ROOT}/out/run.mp4`, roots)).toBe(true);
    expect(isPathWithinRoots(`${TMP}/capture.webm`, roots)).toBe(true);
  });

  it("refuses a path outside every root", () => {
    // The attack this exists for: a REMOTE mcp server has no filesystem access
    // of its own, so naming this path would borrow the manager's.
    const outside = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";
    expect(isPathWithinRoots(outside, roots)).toBe(false);
  });

  it("refuses a sibling whose name merely STARTS with a root", () => {
    // Without the trailing separator, "/wt-secrets" reads as a child of "/wt".
    expect(isPathWithinRoots(`${ROOT}-secrets/x`, roots)).toBe(false);
    expect(isPathWithinRoots(`${ROOT}extra`, roots)).toBe(false);
  });

  it("tolerates trailing slashes and backslashes on either side", () => {
    expect(isPathWithinRoots(`${ROOT}/out/`, [`${ROOT}/`])).toBe(true);
    expect(isPathWithinRoots(ROOT.replace(/\//g, "\\") + "\\a", roots)).toBe(true);
  });

  it("refuses everything when no root is supplied", () => {
    expect(isPathWithinRoots(`${ROOT}/x`, [])).toBe(false);
    expect(isPathWithinRoots(`${ROOT}/x`, [""])).toBe(false);
  });

  it("matches case-insensitively only where the filesystem does", () => {
    const mixed = `${ROOT.toUpperCase()}/OUT/a.mp4`;
    const folds = process.platform === "win32" || process.platform === "darwin";
    expect(isPathWithinRoots(mixed, roots)).toBe(folds);
  });
});

describe("media types", () => {
  it("classifies by prefix, defaulting to a downloadable file", () => {
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/mpeg")).toBe("audio");
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("application/zip")).toBe("file");
    expect(mediaKind(undefined)).toBe("file");
  });

  it("round-trips the video types the ingest path stores", () => {
    expect(mediaTypeFromName("a.mp4")).toBe("video/mp4");
    expect(extFromMediaType("video/mp4")).toBe(".mp4");
    expect(mediaTypeFromName("a.webm")).toBe("video/webm");
  });

  it("calls an unknown extension octet-stream, so a browser downloads it", () => {
    // The old image-only default made every unknown file claim to be a PNG.
    expect(mediaTypeFromName("a.xyz")).toBe("application/octet-stream");
    expect(mediaTypeFromName("noext")).toBe("application/octet-stream");
  });

  it("honors an explicit fallback for the image-only call sites", () => {
    expect(mediaTypeFromName("a.xyz", "image/png")).toBe("image/png");
  });

  it("formats sizes for the one line the model sees", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4.0 MB");
  });
});
