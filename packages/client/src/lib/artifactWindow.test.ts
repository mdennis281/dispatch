import { describe, expect, it } from "vitest";
import {
  artifactWindowFeatures,
  artifactWindowName,
  artifactWindowUrl,
  isArtifactWindowMsg,
  parseArtifactWindowParams,
} from "./artifactWindow.js";
import { useArtifactView } from "../stores/artifacts.js";

describe("artifact window URL", () => {
  it("round-trips chat, artifact and a pinned version", () => {
    const url = artifactWindowUrl({ chatId: "c_1", id: "a-2", version: 3 }, "http://host:4318");
    expect(url).toBe("http://host:4318/?artifact=c_1/a-2&v=3");
    expect(parseArtifactWindowParams(new URL(url).search)).toEqual({ chatId: "c_1", id: "a-2", version: 3 });
  });

  it("follows the newest when no version is pinned", () => {
    const url = artifactWindowUrl({ chatId: "c", id: "a", version: null }, "http://h");
    expect(url).toBe("http://h/?artifact=c/a");
    expect(parseArtifactWindowParams(new URL(url).search)?.version).toBeNull();
  });

  it("survives ids that need escaping", () => {
    const url = artifactWindowUrl({ chatId: "c/1 x", id: "a&b", version: null }, "http://h");
    // The chat id may itself carry a slash once encoded — split on the FIRST raw one.
    expect(parseArtifactWindowParams(new URL(url).search)).toEqual({ chatId: "c/1 x", id: "a&b", version: null });
  });

  it("rejects an address that doesn't name an artifact", () => {
    expect(parseArtifactWindowParams("")).toBeNull();
    expect(parseArtifactWindowParams("?artifact=")).toBeNull();
    expect(parseArtifactWindowParams("?artifact=onlychat")).toBeNull();
    expect(parseArtifactWindowParams("?artifact=c/")).toBeNull();
    expect(parseArtifactWindowParams("?artifact=/a")).toBeNull();
  });

  it("ignores a version that isn't a positive integer", () => {
    expect(parseArtifactWindowParams("?artifact=c/a&v=0")?.version).toBeNull();
    expect(parseArtifactWindowParams("?artifact=c/a&v=-2")?.version).toBeNull();
    expect(parseArtifactWindowParams("?artifact=c/a&v=1.5")?.version).toBeNull();
    expect(parseArtifactWindowParams("?artifact=c/a&v=x")?.version).toBeNull();
  });
});

describe("artifactWindowName", () => {
  it("is one name per artifact, safe as a window target", () => {
    expect(artifactWindowName("c 1", "a/b")).toBe("dp-artifact-c_1-a_b");
    expect(artifactWindowName("c", "a")).not.toBe(artifactWindowName("c", "b"));
  });
});

describe("artifactWindowFeatures", () => {
  // The installed app must NOT pass features: any of them makes it a popup
  // rather than a full app window (see the function's comment).
  it("asks for nothing in the installed app and a sized popup in a tab", () => {
    expect(artifactWindowFeatures(true)).toBeUndefined();
    expect(artifactWindowFeatures(false)).toMatch(/^popup=yes,/);
  });
});

describe("isArtifactWindowMsg", () => {
  it("accepts the protocol and nothing else", () => {
    expect(isArtifactWindowMsg({ type: "who" })).toBe(true);
    expect(isArtifactWindowMsg({ type: "present", chatId: "c", id: "a" })).toBe(true);
    expect(isArtifactWindowMsg({ type: "gone", chatId: "c", id: "a", settled: true })).toBe(true);
    expect(isArtifactWindowMsg({ type: "focus", chatId: "c", id: "a" })).toBe(true);
    expect(isArtifactWindowMsg({ type: "bring-back", chatId: "c", id: "a" })).toBe(true);
    expect(isArtifactWindowMsg({ type: "focus", chatId: "c" })).toBe(false);
    expect(isArtifactWindowMsg({ type: "nope", chatId: "c", id: "a" })).toBe(false);
    expect(isArtifactWindowMsg(null)).toBe(false);
    expect(isArtifactWindowMsg("who")).toBe(false);
  });
});

describe("popped artifacts in the view store", () => {
  it("merges what the window reports over what the pane knew, and forgets on unmark", () => {
    const s = useArtifactView.getState();
    s.markPopped("c", "a", { title: "Game" });
    // The window's first `present` can arrive before its fetch has a title.
    s.markPopped("c", "a", { version: 2 });
    expect(useArtifactView.getState().popped["c:a"]).toEqual({ title: "Game", version: 2 });
    s.unmarkPopped("c", "a");
    expect(useArtifactView.getState().popped["c:a"]).toBeUndefined();
  });
});
