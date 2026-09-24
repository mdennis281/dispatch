import { describe, it, expect } from "vitest";
import { toModelOptions, ollamaHost, AcpHarness } from "./index.js";

/** A `/api/tags` row, shaped as Ollama really returns it. */
const tag = (name: string, size: number, parameter_size?: string) => ({
  name,
  model: name,
  size,
  details: { parameter_size, quantization_level: "Q4_K_M" },
});

describe("toModelOptions", () => {
  it("keeps the pulled tag as both value and label", () => {
    // Prettifying would make the picker disagree with `ollama list`.
    expect(toModelOptions([tag("qwen3-coder:30b", 18_556_700_761, "30.5B")])[0]).toMatchObject({
      value: "qwen3-coder:30b",
      label: "qwen3-coder:30b",
      description: "30.5B · Q4_K_M",
    });
  });

  it("marks the SMALLEST model fast, so title generation picks a cheap one", () => {
    // Regression: the `fast` hint was only ever set on the static seed, so with
    // Ollama reachable nothing matched and generateText fell through to
    // models[0] — whatever order /api/tags returned. A box with a 70B pulled
    // alongside a small model could spend the 70B on a one-line chat title.
    const models = toModelOptions([
      tag("qwen3-coder:30b", 18_556_700_761, "30.5B"),
      tag("llama3.1:8b", 4_920_753_328, "8.0B"),
      tag("gemma4:26b", 17_987_581_215, "26B"),
    ]);
    expect(models.find((m) => m.hint === "fast")?.value).toBe("llama3.1:8b");
    // Exactly one row is hinted.
    expect(models.filter((m) => m.hint === "fast")).toHaveLength(1);
  });

  it("does not label a sole model fast — that says nothing", () => {
    const models = toModelOptions([tag("only:7b", 100)]);
    expect(models[0]!.hint).toBeUndefined();
  });

  it("ignores a row with no size rather than treating it as smallest", () => {
    const models = toModelOptions([
      { name: "unknown:size" },
      tag("small:1b", 500),
      tag("big:70b", 40_000_000_000),
    ]);
    expect(models.find((m) => m.hint === "fast")?.value).toBe("small:1b");
  });

  it("skips a row with no name at all", () => {
    expect(toModelOptions([{ size: 5 }])).toEqual([]);
  });
});

describe("ollamaHost", () => {
  it("defaults to loopback", () => {
    expect(ollamaHost({})).toBe("http://127.0.0.1:11434");
  });

  it("accepts Ollama's own bare host:port convention", () => {
    // `OLLAMA_HOST=0.0.0.0:11434` is what the service itself is configured
    // with, so it is what a user is most likely to copy.
    expect(ollamaHost({ OLLAMA_HOST: "192.0.2.10:11434" })).toBe("http://192.0.2.10:11434");
  });

  it("leaves an explicit URL alone but trims a trailing slash", () => {
    expect(ollamaHost({ OLLAMA_HOST: "http://box:11434/" })).toBe("http://box:11434");
    expect(ollamaHost({ OLLAMA_HOST: "https://box:443" })).toBe("https://box:443");
  });
});

describe("AcpHarness.listModels", () => {
  const harness = (fetchModels: () => Promise<ReturnType<typeof toModelOptions> | null>) =>
    new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchModels,
    });

  it("falls back to the seed rather than erroring when Ollama is unreachable", async () => {
    // A picker with a stale list beats a picker that threw.
    const models = await harness(async () => null).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.value).toBe("qwen3-coder:30b");
  });

  it("survives a probe that rejects", async () => {
    const models = await harness(async () => {
      throw new Error("ECONNREFUSED");
    }).listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("prefers the live list once it answers", async () => {
    const live = toModelOptions([tag("mine:1b", 10)]);
    expect(await harness(async () => live).listModels()).toEqual(live);
  });
});

describe("AcpHarness.createSession", () => {
  it("refuses with an actionable message when goose is absent", () => {
    const harness = new AcpHarness({
      runtime: { kind: "goose", source: "missing", available: false },
    });
    expect(() =>
      harness.createSession({
        permissionMode: "default",
        effort: "medium",
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      }),
    ).toThrow(/DISPATCH_GOOSE_PATH/);
  });

  const spec = (model?: string) => ({
    permissionMode: "default" as const,
    effort: "medium" as const,
    systemPromptAppends: [],
    mcpServers: {},
    skills: [],
    ...(model ? { model } : {}),
  });

  const installed = (fetchModels: () => Promise<ReturnType<typeof toModelOptions> | null>) =>
    new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchModels,
      connect: () => ({ ready: async () => ({}) }) as never,
    });

  it("refuses a model the configured host has never pulled, and names what it does have", async () => {
    // The failure this prevents: OLLAMA_HOST unset resolves to loopback, a
    // second small Ollama answers there, and the 30B the user meant lives on
    // another box. Before this the session opened anyway and failed later,
    // somewhere far less legible.
    const harness = installed(async () => toModelOptions([tag("llama3.1:8b", 4_920_753_328)]));
    await harness.listModels();
    expect(() => harness.createSession(spec("qwen3-coder:30b"))).toThrow(/llama3\.1:8b/);
    // And says which host, since with accounts there is more than one candidate.
    expect(() => harness.createSession(spec("qwen3-coder:30b"))).toThrow(/127\.0\.0\.1:11434/);
  });

  it("allows a model that IS there", async () => {
    const harness = installed(async () => toModelOptions([tag("llama3.1:8b", 4_920_753_328)]));
    await harness.listModels();
    expect(() => harness.createSession(spec("llama3.1:8b"))).not.toThrow();
  });

  it("validates against the ACCOUNT's host, not the ambient one", async () => {
    // Two boxes, different models pulled. The 30B exists on the GPU host and
    // nowhere else; a chat on that account must open, and the same model on
    // the local account must not.
    const byHost: Record<string, ReturnType<typeof toModelOptions>> = {
      "http://127.0.0.1:11434": toModelOptions([tag("gemma4:latest", 9_608_350_718)]),
      "http://192.0.2.10:11434": toModelOptions([tag("qwen3-coder:30b", 18_556_700_761)]),
    };
    const harness = new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchModels: async (origin) => byHost[origin] ?? [],
      connect: () => ({ ready: async () => ({}) }) as never,
    });

    const gpu = { subscriptionId: "gpu", configDir: "/x", env: { OLLAMA_HOST: "192.0.2.10:11434" } };
    const local = { subscriptionId: "local", configDir: "/x", env: {} };

    expect((await harness.listModels({ account: gpu })).map((m) => m.value)).toEqual([
      "qwen3-coder:30b",
    ]);
    expect((await harness.listModels({ account: local })).map((m) => m.value)).toEqual([
      "gemma4:latest",
    ]);

    expect(() =>
      harness.createSession({ ...spec("qwen3-coder:30b"), account: gpu }),
    ).not.toThrow();
    expect(() => harness.createSession({ ...spec("qwen3-coder:30b"), account: local })).toThrow(
      /gemma4:latest/,
    );
  });

  it("does not refuse on a list older than the TTL — a model pulled since is real", async () => {
    // The bug: this read went straight to the cache map and never applied the
    // TTL that listModels() applies, and only the model picker ever refreshed
    // that map. Pull a model, start a chat on it, and it was refused forever
    // while /api/tags had it all along. Past the TTL we decline to judge.
    let clock = 0;
    let pulled = [tag("llama3.1:8b", 4_920_753_328)];
    const harness = new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchModels: async () => toModelOptions(pulled),
      connect: () => ({ ready: async () => ({}) }) as never,
      now: () => clock,
    });

    await harness.listModels();
    // Fresh list: the refusal still stands, which is the behaviour worth keeping.
    expect(() => harness.createSession(spec("devstral:latest"))).toThrow(/llama3\.1:8b/);

    pulled = [...pulled, tag("devstral:latest", 14_333_909_728)];
    clock += 5 * 60 * 1000;
    expect(() => harness.createSession(spec("devstral:latest"))).not.toThrow();
  });

  it("re-probes on the stale path, so the next attempt judges against the truth", async () => {
    let clock = 0;
    let probes = 0;
    const harness = new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchModels: async () => {
        probes += 1;
        return toModelOptions([tag("llama3.1:8b", 4_920_753_328)]);
      },
      connect: () => ({ ready: async () => ({}) }) as never,
      now: () => clock,
    });

    await harness.listModels();
    expect(probes).toBe(1);

    clock += 5 * 60 * 1000;
    harness.createSession(spec("devstral:latest"));
    await new Promise((r) => setImmediate(r));
    expect(probes).toBe(2);
  });

  it("does not refuse anything when the probe failed — a seed cannot know what is pulled", async () => {
    // listModels() falls back to a static seed when Ollama is unreachable.
    // Validating against that would reject working models every time the probe
    // happened to be down; unreachable is a different error and arrives on its own.
    const harness = installed(async () => null);
    await harness.listModels();
    expect(() => harness.createSession(spec("anything-at-all:70b"))).not.toThrow();
  });
});

describe("AcpHarness.contextWindow", () => {
  const harness = (fetchContextWindow: (o: string, m: string) => Promise<number | undefined>) =>
    new AcpHarness({
      runtime: { kind: "goose", source: "installed", available: true, path: "/x/goose" },
      fetchContextWindow,
    });

  it("reports what Ollama SERVES, which is not what the weights support", async () => {
    // The distinction is the whole point. /api/show says qwen3-coder supports
    // 262144; /api/ps says the running instance was loaded with 32768. A
    // prompt is rejected against the second, so answering with the first would
    // promise 8x the room that exists — in the direction that hurts.
    const h = harness(async () => 32_768);
    expect(await h.contextWindow({ model: "qwen3-coder:30b" })).toBe(32_768);
  });

  it("asks the account's host, not the ambient one", async () => {
    const seen: string[] = [];
    const h = harness(async (origin) => {
      seen.push(origin);
      return 8_192;
    });
    await h.contextWindow({
      model: "m",
      account: { subscriptionId: "gpu", configDir: "/x", env: { OLLAMA_HOST: "192.0.2.10:11434" } },
    });
    expect(seen).toEqual(["http://192.0.2.10:11434"]);
  });

  it("answers nothing for a model that is not loaded, rather than guessing", async () => {
    // Ollama has not decided that model's context yet, so there is no true
    // answer — and undefined leaves every caller on its previous behaviour.
    expect(await harness(async () => undefined).contextWindow({ model: "cold:7b" })).toBeUndefined();
  });

  it("answers nothing when no model is named", async () => {
    let called = false;
    const h = harness(async () => {
      called = true;
      return 32_768;
    });
    expect(await h.contextWindow({})).toBeUndefined();
    expect(called).toBe(false);
  });

  it("survives an unreachable Ollama", async () => {
    const h = harness(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await h.contextWindow({ model: "m" })).toBeUndefined();
  });

  it("caches per host and model", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return 32_768;
    });
    await h.contextWindow({ model: "a" });
    await h.contextWindow({ model: "a" });
    expect(calls).toBe(1);
    await h.contextWindow({ model: "b" });
    expect(calls).toBe(2);
  });
});

describe("GOOSE_AGENT.env", () => {
  it("tells goose the real limit, so its own compaction works on the truth", async () => {
    // Unset, goose assumes a limit of its own (it reports size: 128000 in
    // every usage_update whatever is loaded), so auto-compaction manages a
    // window four times the real one and never fires — and Ollama rejects the
    // prompt outright instead.
    const { GOOSE_AGENT } = await import("./index.js");
    expect(GOOSE_AGENT.env("qwen3-coder:30b", 32_768).GOOSE_CONTEXT_LIMIT).toBe("32768");
  });

  it("says nothing when the window is unknown — a guess is worse than silence", async () => {
    const { GOOSE_AGENT } = await import("./index.js");
    expect(GOOSE_AGENT.env("m", undefined).GOOSE_CONTEXT_LIMIT).toBeUndefined();
    expect(GOOSE_AGENT.env("m").GOOSE_CONTEXT_LIMIT).toBeUndefined();
  });
});

describe("AcpHarness.readLimits", () => {
  it("returns null, so the usage meter hides instead of showing an empty gauge", async () => {
    expect(await new AcpHarness().readLimits()).toBeNull();
  });
});
