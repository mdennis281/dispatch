import { describe, expect, it } from "vitest";
import type { ArtifactMeta, ChatMediaItem } from "@dispatch/shared";
import { attachmentCount, groupAttachments } from "./chatAttachments.js";

const media = (path: string, mimeType?: string, from: "user" | "agent" = "agent"): ChatMediaItem => ({
  asset: { id: path, path, mimeType },
  rowId: `r-${path}`,
  from,
});

const artifact = (id: string, updatedAt: number): ArtifactMeta => ({
  id,
  chatId: "c",
  title: id,
  type: "html",
  createdAt: 0,
  updatedAt,
  versions: [{ n: 1, createdAt: 0, size: 1 }],
});

describe("groupAttachments", () => {
  it("puts images and video in the grid, everything else in files", () => {
    const g = groupAttachments(
      [],
      [media("a.png", "image/png"), media("b.mp4", "video/mp4"), media("c.mp3", "audio/mpeg"), media("d.zip")],
    );
    expect(g.images.map((i) => i.asset.path)).toEqual(["b.mp4", "a.png"]);
    expect(g.files.map((i) => i.asset.path)).toEqual(["d.zip", "c.mp3"]);
  });

  it("lists newest first without reordering the gallery it was given", () => {
    // The viewer walks the gallery in transcript order; only the menu reverses.
    const gallery = [media("1.png", "image/png"), media("2.png", "image/png")];
    const g = groupAttachments([], gallery);
    expect(g.images.map((i) => i.asset.path)).toEqual(["2.png", "1.png"]);
    expect(gallery.map((i) => i.asset.path)).toEqual(["1.png", "2.png"]);
  });

  it("orders artifacts by last edit, not by the order the route sent", () => {
    const g = groupAttachments([artifact("old", 1), artifact("new", 9), artifact("mid", 5)], []);
    expect(g.artifacts.map((a) => a.id)).toEqual(["new", "mid", "old"]);
  });

  it("counts every kind", () => {
    const g = groupAttachments([artifact("x", 1)], [media("a.png", "image/png"), media("f.txt", "text/plain")]);
    expect(attachmentCount(g)).toBe(3);
  });
});
