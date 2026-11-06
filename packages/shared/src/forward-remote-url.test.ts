import { describe, it, expect } from "vitest";
import { defaultForwardRemoteUrl } from "./terminal-backend.js";

describe("defaultForwardRemoteUrl (E23)", () => {
  it("swaps the forward's host and port for the machine's own localhost:<remotePort>", () => {
    expect(defaultForwardRemoteUrl("http://127.0.0.1:53211", 5173)).toBe("http://localhost:5173");
    expect(defaultForwardRemoteUrl("http://127.0.0.1:53211/", 5173)).toBe("http://localhost:5173/");
  });

  it("keeps the scheme, path, query and fragment exactly as the backend wrote them", () => {
    expect(defaultForwardRemoteUrl("https://[::1]:40000/app/?x=1#top", 3000)).toBe("https://localhost:3000/app/?x=1#top");
    expect(defaultForwardRemoteUrl("http://user:pw@host:9/p", 8080)).toBe("http://localhost:8080/p");
  });

  it("falls back to plain http on localhost for a url it cannot read", () => {
    expect(defaultForwardRemoteUrl("not a url", 4000)).toBe("http://localhost:4000");
  });
});
