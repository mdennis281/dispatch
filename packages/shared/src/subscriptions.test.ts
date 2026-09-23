import { describe, it, expect } from "vitest";
import {
  chatAccountOf,
  endpointOrigin,
  resolveSubscriptions,
  subscriptionFor,
  SubscriptionListSchema,
} from "./subscriptions.js";
import { PROVIDER_IDS } from "./providers.js";

describe("resolveSubscriptions", () => {
  it("gives an install with no list one implicit account per provider", () => {
    const all = resolveSubscriptions({});
    // Derived from the registry rather than spelled out, so registering a new
    // provider does not fail a test about the mechanism.
    expect(all.map((s) => [s.id, s.provider, s.implicit])).toEqual(
      PROVIDER_IDS.map((id) => [id, id, true]),
    );
  });

  it("fills in only the providers the stored list says nothing about", () => {
    // Listing two Claude logins must not make the other providers unusable.
    const all = resolveSubscriptions({
      subscriptions: [
        { id: "claude1", name: "one", provider: "claude" },
        { id: "claude2", name: "two", provider: "claude", configDir: "/x/.claude2" },
      ],
    });
    expect(all.map((s) => s.id)).toEqual([
      "claude1",
      "claude2",
      ...PROVIDER_IDS.filter((id) => id !== "claude"),
    ]);
  });

  it("never lets an implicit id collide with a stored one", () => {
    const all = resolveSubscriptions({
      subscriptions: [{ id: "codex", name: "a Claude login named codex", provider: "claude" }],
    });
    expect(all.find((s) => s.provider === "codex")?.id).toBe("codex-2");
  });
});

describe("chatAccountOf", () => {
  /** A status row as the server sends it. */
  const status = (
    id: string,
    provider: "claude" | "goose",
    extra: { atDefaultDir?: boolean; isDefault?: boolean } = {},
  ) => ({
    id,
    name: id,
    provider,
    resolvedConfigDir: "/home/.config",
    dirExists: true,
    loggedIn: true,
    isDefault: false,
    atDefaultDir: true,
    ...extra,
  });

  it("falls through to the chosen default for goose, whose accounts share a directory", () => {
    // Mirrors the server's `chatSubscription`. Every goose account is at the
    // default dir, so matching on that would never reach `isDefault` and the
    // composer would show the wrong account as active.
    const statuses = [
      status("goose1", "goose"),
      status("goose2", "goose", { isDefault: true }),
    ];
    expect(chatAccountOf(statuses, {}, "goose")?.id).toBe("goose2");
  });

  it("still prefers the default DIRECTORY for a provider whose account is one", () => {
    const statuses = [
      status("claude1", "claude", { atDefaultDir: false }),
      status("claude2", "claude", { atDefaultDir: true }),
      status("claude3", "claude", { atDefaultDir: false, isDefault: true }),
    ];
    expect(chatAccountOf(statuses, {}, "claude")?.id).toBe("claude2");
  });

  it("always prefers an explicit pin", () => {
    const statuses = [status("goose1", "goose"), status("goose2", "goose", { isDefault: true })];
    expect(chatAccountOf(statuses, { subscriptionId: "goose1" }, "goose")?.id).toBe("goose1");
  });
});

describe("endpointOrigin", () => {
  it("accepts Ollama's own bare host:port, which is what a user copies", () => {
    // 192.0.2.0/24 is RFC 5737 documentation space — reserved precisely so a
    // fixture cannot name someone's real machine. Keep it that way: a real
    // address here would publish a LAN's topology in a public repo, and a
    // routable one risks a test one day actually dialling it.
    expect(endpointOrigin("192.0.2.10:11434")).toBe("http://192.0.2.10:11434");
  });

  it("leaves an explicit scheme alone and strips trailing slashes", () => {
    expect(endpointOrigin("https://box:443/")).toBe("https://box:443");
    expect(endpointOrigin("  http://box:11434//  ")).toBe("http://box:11434");
  });

  it("stays fast on a long run of trailing slashes", () => {
    // CodeQL flagged the anchored `/\/+$/` this replaced as polynomial. The
    // stored field is capped at 200 chars, but this also normalises
    // `OLLAMA_HOST` out of the environment, where nothing is capped.
    const started = Date.now();
    expect(endpointOrigin(`http://box:11434${"/".repeat(50_000)}`)).toBe("http://box:11434");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not invent a host out of a string that is only slashes", () => {
    expect(endpointOrigin("///")).toBe("http:");
  });
});

describe("subscriptionFor", () => {
  const settings = {
    subscriptions: [
      { id: "claude1", name: "one", provider: "claude" as const },
      { id: "claude2", name: "two", provider: "claude" as const, configDir: "/x/.claude2" },
      { id: "codex1", name: "codex", provider: "codex" as const },
    ],
  };

  it("honours a pin on the chat's own provider", () => {
    expect(subscriptionFor(settings, "claude", "claude2").id).toBe("claude2");
  });

  it("falls back to the provider default for a deleted or cross-provider pin", () => {
    expect(subscriptionFor(settings, "claude", "gone").id).toBe("claude1");
    // A Codex chat must never be handed a Claude config dir.
    expect(subscriptionFor(settings, "codex", "claude2").id).toBe("codex1");
  });

  it("uses the provider's preferred default when one is set", () => {
    const preferring = {
      ...settings,
      harness: { defaults: { claude: { subscriptionId: "claude2" } } },
    };
    expect(subscriptionFor(preferring, "claude").id).toBe("claude2");
  });
});

describe("SubscriptionListSchema", () => {
  it("refuses duplicate ids and non-slug ids", () => {
    const one = { id: "a", name: "A", provider: "claude" };
    expect(SubscriptionListSchema.safeParse([one, one]).success).toBe(false);
    expect(SubscriptionListSchema.safeParse([{ ...one, id: "Has Space" }]).success).toBe(false);
  });
});
