import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, PRRef, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import {
  PrRegistry,
  PR_POLL_HOT_MS,
  PR_POLL_BACKOFF_MS,
  PR_ACTIVE_WINDOW_MS,
  PR_POLL_WATCHED_MS,
  PR_WATCH_TTL_MS,
} from "./pr-registry.js";
import type { PrPollSnapshot } from "./github.js";

let root: string;
let bus: EventBus;
let store: Store;
let events: WsServerEvent[];
let now: number;

const REPO = "octo/repo";
const KEY = "octo/repo#42";

const REF: PRRef = {
  number: 42,
  url: "https://github.com/octo/repo/pull/42",
  branch: "feat/x",
  repo: REPO,
  title: "feat: x",
  state: "open",
};

/** An ordinary open PR snapshot; each test overrides only what it's about. */
function snapshot(over: Partial<PrPollSnapshot> = {}): PrPollSnapshot {
  return {
    repo: REPO,
    number: 42,
    url: REF.url,
    title: "feat: x",
    branch: "feat/x",
    baseBranch: "main",
    state: "open",
    merged: false,
    isDraft: false,
    labels: [],
    mergeable: true,
    reviewDecision: null,
    reviewers: [],
    threads: [],
    checks: [{ name: "build", status: "completed", conclusion: "success" }],
    requested: [],
    reported: [],
    ...over,
  };
}

/** Clock-injected so cadence is asserted directly rather than waited out. */
function makeRegistry(): PrRegistry {
  return new PrRegistry({ store, bus, now: () => now });
}

const records = (): Array<Extract<WsServerEvent, { type: "pr-record-update" }>["record"]> =>
  events
    .filter((e): e is Extract<WsServerEvent, { type: "pr-record-update" }> =>
      e.type === "pr-record-update",
    )
    .map((e) => e.record);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-prreg-"));
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  store = new Store(join(root, "data"));
  await store.init();
  now = 1_000_000;
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("PrRegistry — rows", () => {
  it("records a poll and announces it", async () => {
    const reg = makeRegistry();
    const rec = await reg.record(snapshot(), { chatId: "c1", projectId: "p1" });

    expect(rec.key).toBe(KEY);
    expect(rec.chatId).toBe("c1");
    expect(rec.projectId).toBe("p1");
    expect(rec.lastPolledAt).toBe(now);
    expect(records().map((r) => r.key)).toEqual([KEY]);
    // It survives the process, which is the whole difference from what came
    // before: every previous PR read was thrown away.
    expect((await store.listPrRecords()).map((r) => r.key)).toEqual([KEY]);
  });

  it("precomputes `hold` from ANY of the labels a human might use", async () => {
    const reg = makeRegistry();
    const rec = await reg.record(snapshot({ labels: ["do-not-merge"] }));
    // Not just the `hold` label this app writes — a PR parked by convention must
    // not read as ready to land because the spelling differs.
    expect(rec.hold).toBe(true);
  });

  it("never lets a discovery pass erase an attributed row's chat", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot(), { chatId: "c1", projectId: "p1" });
    // Discovery finds the same PR project-wide and knows nothing about the chat.
    const after = await reg.record(snapshot(), { projectId: "p1" });
    expect(after.chatId).toBe("c1");
  });

  it("stays quiet when a poll changes nothing, and speaks when it does", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot());
    expect(records()).toHaveLength(1);

    now += PR_POLL_HOT_MS;
    await reg.record(snapshot());
    // A socket message per tracked PR per sweep, saying nothing, is how a live
    // feed teaches a client to ignore it.
    expect(records()).toHaveLength(1);

    now += PR_POLL_HOT_MS;
    await reg.record(snapshot({ reviewDecision: "approved" }));
    expect(records()).toHaveLength(2);
    expect(records()[1]!.reviewDecision).toBe("approved");
  });

  // A rendered field missing from the fingerprint moves on the stored row
  // WITHOUT reaching a client, so the roster sits stale until some unrelated
  // change or a reconnect flushes it. Every field the catalog draws is here.
  it.each([
    ["branch", { branch: "feat/renamed" }],
    ["baseBranch", { baseBranch: "release/2" }],
    ["author", { author: "someone-else" }],
    ["a thread going outdated", { threads: [{ id: "T_1", isResolved: false, isOutdated: true }] }],
  ])("announces a change to %s", async (_label, over) => {
    const reg = makeRegistry();
    const before = snapshot({ threads: [{ id: "T_1", isResolved: false, isOutdated: false }] });
    await reg.record(before);
    events.length = 0;

    now += PR_POLL_HOT_MS;
    await reg.record({ ...before, ...(over as Partial<PrPollSnapshot>) });

    expect(records()).toHaveLength(1);
  });

  it("does not treat a bare `updatedAt` bump as activity", async () => {
    // GitHub bumps it for things this catalog doesn't show; counting it would
    // pin every PR to the hot cadence and make the backoff ornamental.
    const reg = makeRegistry();
    const first = await reg.record(snapshot({ updatedAt: "2026-08-01T00:00:00Z" }));
    now += PR_POLL_HOT_MS;
    const second = await reg.record(snapshot({ updatedAt: "2026-08-02T00:00:00Z" }));
    expect(second.lastChangedAt).toBe(first.lastChangedAt);
    expect(second.quietPolls).toBe(1);
  });
});

describe("PrRegistry — adaptive cadence", () => {
  /** Push a row past the "recently active" window so backoff can be observed. */
  async function settle(reg: PrRegistry, snap: PrPollSnapshot) {
    await reg.record(snap);
    now += PR_ACTIVE_WINDOW_MS;
    return reg.record(snap);
  }

  it("stays HOT while a reviewer is on the hook", async () => {
    const reg = makeRegistry();
    const rec = await settle(
      reg,
      snapshot({ reviewers: [{ login: "copilot", kind: "bot", state: "requested" }] }),
    );
    // Backing off here would trade away the thing the background sweep exists
    // for: noticing the review round promptly.
    expect(rec.nextPollAt - now).toBe(PR_POLL_HOT_MS);
  });

  it("stays HOT while a review is actually running", async () => {
    const reg = makeRegistry();
    const rec = await settle(
      reg,
      snapshot({ reviewers: [{ login: "copilot", kind: "bot", state: "in_progress" }] }),
    );
    expect(rec.nextPollAt - now).toBe(PR_POLL_HOT_MS);
  });

  it("stays HOT while CI is in flight", async () => {
    const reg = makeRegistry();
    const rec = await settle(
      reg,
      snapshot({ checks: [{ name: "build", status: "in_progress" }] }),
    );
    expect(rec.nextPollAt - now).toBe(PR_POLL_HOT_MS);
  });

  it("stays HOT for a while after any change, then backs off when parked", async () => {
    const reg = makeRegistry();
    // Nobody queued, CI done, nothing moving — a genuinely parked PR.
    const parked = snapshot();
    let rec = await reg.record(parked);
    expect(rec.nextPollAt - now).toBe(PR_POLL_HOT_MS);

    // Still inside the active window: hot.
    now += PR_POLL_HOT_MS;
    rec = await reg.record(parked);
    expect(rec.nextPollAt - now).toBe(PR_POLL_HOT_MS);

    // Past it, and quiet: the ladder starts.
    now += PR_ACTIVE_WINDOW_MS;
    rec = await reg.record(parked);
    expect(rec.nextPollAt - now).toBe(PR_POLL_BACKOFF_MS[2]!);
  });

  it("resets to HOT the moment something changes", async () => {
    const reg = makeRegistry();
    const parked = snapshot();
    await reg.record(parked);
    now += PR_ACTIVE_WINDOW_MS * 2;
    await reg.record(parked);
    const woken = await reg.record(
      snapshot({ reviewDecision: "changes_requested" }),
    );
    expect(woken.quietPolls).toBe(0);
    expect(woken.nextPollAt - now).toBe(PR_POLL_HOT_MS);
  });

  it("drops to the WATCHED cadence while an agent is blocked on the PR", async () => {
    const reg = makeRegistry();
    // A parked PR that has backed off as far as the ladder goes.
    const parked = snapshot();
    await reg.record(parked);
    now += PR_ACTIVE_WINDOW_MS;
    const cold = await reg.record(parked);
    // One quiet poll past the active window — the first rung of the ladder.
    expect(cold.nextPollAt - now).toBe(PR_POLL_BACKOFF_MS[1]!);

    // An agent starts watching. Waiting ten minutes to notice a merge while a
    // chat sits idle is the most visible slowness this app has.
    const watched = await reg.noteWatched(REPO, 42);
    expect(watched!.nextPollAt - now).toBeLessThanOrEqual(PR_POLL_WATCHED_MS);
    const next = await reg.record(parked);
    expect(next.nextPollAt - now).toBe(PR_POLL_WATCHED_MS);
  });

  it("lets the watch window lapse on its own", async () => {
    // Nothing has to remember to clear it: an agent that stops watching simply
    // stops renewing, so a killed session cannot pin a PR to 30s forever.
    const reg = makeRegistry();
    await reg.record(snapshot());
    await reg.noteWatched(REPO, 42);
    now += PR_WATCH_TTL_MS + PR_ACTIVE_WINDOW_MS;
    const after = await reg.record(snapshot());
    expect(after.nextPollAt - now).toBeGreaterThan(PR_POLL_WATCHED_MS);
  });

  it("does not invent a row for a PR it has never heard of", async () => {
    // `watch_pr` can be pointed at any number; a hollow row from a watch would
    // put PRs in the roster that nothing is actually tracking.
    const reg = makeRegistry();
    expect(await reg.noteWatched(REPO, 999)).toBeNull();
    expect(await reg.list()).toEqual([]);
  });

  it("finds the PR that owns a review thread", async () => {
    // `resolve_thread` is handed a thread id and nothing else — this is what
    // turns it into a card about a pull request.
    const reg = makeRegistry();
    await reg.record(
      snapshot({ threads: [{ id: "PRRT_1", isResolved: false, path: "a.ts" }] }),
    );
    expect((await reg.findByThread("PRRT_1"))?.number).toBe(42);
    expect(await reg.findByThread("PRRT_nope")).toBeNull();
    expect(await reg.findByThread("")).toBeNull();
  });

  it("never returns a settled PR as due — it is over", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot({ state: "merged", merged: true }));
    now += PR_POLL_BACKOFF_MS[2]! * 10;
    expect(await reg.due(now)).toEqual([]);
  });

  it("returns an open row once its next poll comes round", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot());
    expect(await reg.due(now)).toEqual([]);
    now += PR_POLL_HOT_MS;
    expect((await reg.due(now)).map((r) => r.number)).toEqual([42]);
  });
});

describe("PrRegistry — tracking from the ownership pointer", () => {
  async function makeChat(id: string, prs: PRRef[]): Promise<Chat> {
    return store.saveChat({
      id,
      projectId: "p1",
      title: id,
      modeId: "default",
      effort: "medium",
      worktrees: [],
      prs,
      createdAt: 1,
    } as Chat);
  }

  it("creates a row from a PRRef alone, due immediately", async () => {
    const reg = makeRegistry();
    const rec = await reg.track(REF, { chatId: "c1" });
    expect(rec?.key).toBe(KEY);
    expect(rec?.lastPolledAt).toBe(0);
    // A brand-new PR must be polled on the very next sweep, not after a cadence
    // it has no state to justify.
    expect((await reg.due(now)).map((r) => r.number)).toEqual([42]);
  });

  it("is a no-op for a row that already exists — no write, no announcement", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot({ reviewDecision: "approved" }), { chatId: "c1" });
    events.length = 0;

    const again = await reg.track(REF, { chatId: "c1" });

    // The sweep calls this for every open PR every pass; if it rewrote the row
    // it would also throw away the state the last poll gathered.
    expect(again?.reviewDecision).toBe("approved");
    expect(records()).toEqual([]);
  });

  it("ignores a ref with no repo — there is no key for it", async () => {
    const reg = makeRegistry();
    // Keying on the bare number would let one project's PR #42 collide with
    // another's, which is exactly what this key shape prevents.
    expect(await reg.track({ ...REF, repo: undefined }, { chatId: "c1" })).toBeNull();
    expect(await store.listPrRecords()).toEqual([]);
  });

  it("backfills every chat's PRs at boot, with no GitHub calls", async () => {
    await makeChat("c1", [REF]);
    await makeChat("c2", [{ ...REF, number: 7, repo: "octo/other" }]);
    const reg = makeRegistry();

    expect(await reg.backfill()).toBe(2);
    const rows = await reg.list();
    expect(rows.map((r) => r.key).sort()).toEqual(["octo/other#7", "octo/repo#42"]);
    // Ownership comes FROM `Chat.prs`, which stays the pointer of record.
    expect(rows.every((r) => !!r.chatId && r.projectId === "p1")).toBe(true);
  });
});

describe("PrRegistry — the catalog query", () => {
  it("narrows by scope through the shared registry predicate", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot(), { chatId: "c1", projectId: "p1" });
    await reg.record(snapshot({ number: 43 }), { projectId: "p2" });

    expect((await reg.list({ scope: "all" })).map((r) => r.number).sort()).toEqual([42, 43]);
    expect((await reg.list({ scope: "chat", chatId: "c1" })).map((r) => r.number)).toEqual([42]);
    expect((await reg.list({ scope: "project", projectId: "p2" })).map((r) => r.number)).toEqual([
      43,
    ]);
    // A narrow scope with a missing id returns NOTHING rather than silently
    // widening — the invariant every catalog in this app shares.
    expect(await reg.list({ scope: "chat" })).toEqual([]);
  });

  it("matches free text over title, branch, repo, author and #number", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot({ title: "fix the flake", author: "octocat" }));
    await reg.record(snapshot({ number: 43, title: "unrelated", branch: "chore/deps" }));

    expect((await reg.list({ scope: "all", q: "flake" })).map((r) => r.number)).toEqual([42]);
    expect((await reg.list({ scope: "all", q: "chore/" })).map((r) => r.number)).toEqual([43]);
    expect((await reg.list({ scope: "all", q: "#43" })).map((r) => r.number)).toEqual([43]);
    expect((await reg.list({ scope: "all", q: "octocat" })).map((r) => r.number)).toEqual([42]);
  });

  it("keeps a failed poll's reason ON the row rather than dropping it", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot());
    await reg.noteError(REPO, 42, "GitHub could not be read for this PR");

    const rec = await store.getPrRecord(KEY);
    // A stale row that says why it's stale is honest; one that keeps presenting
    // old state as current is not.
    expect(rec?.pollError).toContain("could not be read");
    // And it is still looked at on the hot cadence — a failure is not a reason
    // to stop looking.
    expect(rec!.nextPollAt - now).toBe(PR_POLL_HOT_MS);
  });

  it("announces the poll that CLEARS an error, even if nothing else changed", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot());
    await reg.noteError(REPO, 42, "boom");
    events.length = 0;

    await reg.record(snapshot());

    // "The catalog is trustworthy again" is news even when the state isn't.
    expect(records()).toHaveLength(1);
    expect(records()[0]!.pollError).toBeUndefined();
  });
});

describe("PrRegistry — Dispatch's own reviewer", () => {
  it("is idempotent against the head it was asked at", async () => {
    // The sweep re-observes GitHub's reviewer queue every pass. A write per pass
    // would be a write every 90 seconds, forever, for one standing request.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    const first = await reg.requestReviewAgent(REPO, 42, "c1");
    now += 60_000;
    const again = await reg.requestReviewAgent(REPO, 42, "c1");

    expect(first?.reviewAgent).toMatchObject({ requestedSha: "sha-1", requestedBy: "c1" });
    expect(again?.reviewAgent?.requestedAt).toBe(first?.reviewAgent?.requestedAt);
  });

  it("re-arms once the head moves, because a push is genuinely new code", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    const first = await reg.requestReviewAgent(REPO, 42, "c1");
    now += 60_000;
    await reg.record(snapshot({ headRefOid: "sha-2" }), { chatId: "c1" });
    const after = await reg.requestReviewAgent(REPO, 42, "c1");

    expect(first?.reviewAgent?.requestedSha).toBe("sha-1");
    expect(after?.reviewAgent?.requestedSha).toBe("sha-2");
  });

  it("does nothing for a PR the catalog has never heard of", async () => {
    // Same rule as `noteWatched`: a request must not conjure a hollow row.
    const reg = makeRegistry();
    expect(await reg.requestReviewAgent(REPO, 999, "c1")).toBeNull();
    expect(await store.getPrRecord("octo/repo#999")).toBeNull();
  });

  it("refuses a claim with no request behind it", async () => {
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    expect(await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 })).toBeNull();
  });

  it("keeps the reviewer's state across an ordinary poll", async () => {
    // `record()` rewrites the row from the snapshot every sweep, and the
    // reviewer's bookkeeping is not in a snapshot. If it were spread away here,
    // the dedup would reset on the next poll and re-review the same head.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    await reg.requestReviewAgent(REPO, 42, "c1");
    await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 });
    await reg.noteReviewChat(REPO, 42, "chat-9");

    now += 60_000;
    await reg.record(snapshot({ headRefOid: "sha-1", title: "renamed" }), { chatId: "c1" });

    const row = await store.getPrRecord(KEY);
    expect(row?.title).toBe("renamed");
    expect(row?.reviewAgent).toMatchObject({
      rounds: 1,
      reviewedSha: "sha-1",
      chatId: "chat-9",
    });
  });

  it("records a posted review, so a finished round is not still 'in flight'", async () => {
    // The claim is taken before the reviewer chat exists, so `reviewedAt` cannot
    // be the completion signal. This is.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    await reg.requestReviewAgent(REPO, 42, "c1");
    await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 });
    await reg.noteReviewChat(REPO, 42, "chat-9");
    now += 60_000;

    const done = await reg.notePostedReview(REPO, 42, {
      chatId: "chat-9",
      findings: 2,
      event: "REQUEST_CHANGES",
    });
    expect(done?.reviewAgent).toMatchObject({
      postedAt: now,
      findings: 2,
      postedEvent: "REQUEST_CHANGES",
      maxRounds: 3,
    });
  });

  it("ignores a post from a chat that holds no lease on this PR", async () => {
    // A human's chat calling `post_review` on a PR Dispatch reviewed last week
    // would otherwise re-date that old round to now and overwrite its findings.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    await reg.requestReviewAgent(REPO, 42, "c1");
    await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 });
    await reg.noteReviewChat(REPO, 42, "chat-9");

    expect(await reg.notePostedReview(REPO, 42, { chatId: "somebody-else" })).toBeNull();
    expect((await store.getPrRecord(KEY))?.reviewAgent?.postedAt).toBeUndefined();
  });

  it("clears the previous round's verdict when the next one is claimed", async () => {
    // Otherwise a round that dies before filing keeps showing the round BEFORE
    // it as its result — the row would report findings about code it never saw.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    await reg.requestReviewAgent(REPO, 42, "c1");
    await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 });
    await reg.noteReviewChat(REPO, 42, "chat-9");
    await reg.notePostedReview(REPO, 42, { chatId: "chat-9", findings: 2, event: "COMMENT" });

    now += 60_000;
    await reg.record(snapshot({ headRefOid: "sha-2" }), { chatId: "c1" });
    await reg.requestReviewAgent(REPO, 42, "c1");
    const second = await reg.claimReviewAgent(REPO, 42, { maxRounds: 3 });

    expect(second?.reviewAgent).toMatchObject({ rounds: 2, reviewedSha: "sha-2" });
    expect(second?.reviewAgent?.postedAt).toBeUndefined();
    expect(second?.reviewAgent?.findings).toBeUndefined();
    expect(second?.reviewAgent?.postedEvent).toBeUndefined();
  });
});

describe("PrRegistry — why the reviewer is not running", () => {
  it("records a blocking problem even though nothing ever asked for a review", async () => {
    // The dedicated-with-no-credential case records NO request — there is no
    // account to put in GitHub's queue and nothing local asks on its behalf. So
    // this is the one write that may create the reviewer state from nothing;
    // without it the fault has no row to sit on and stays invisible.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });

    const row = await reg.notePolicy(REPO, 42, { maxRounds: 4, problem: "no account" });
    expect(row?.reviewAgent).toMatchObject({ rounds: 0, maxRounds: 4, problem: "no account" });
  });

  it("conjures nothing for a healthy project that has never asked", async () => {
    // `maxRounds` alone is not worth turning "nobody asked" into a stored object
    // on every open PR in every project.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });

    expect(await reg.notePolicy(REPO, 42, { maxRounds: 4 })).not.toBeNull();
    expect((await store.getPrRecord(KEY))?.reviewAgent).toBeUndefined();
  });

  it("writes only on a real change — the sweep asks every 90 seconds", async () => {
    // A write per pass would be a `pr-record-update` broadcast per pass to every
    // connected client, for a value that changes about once a year.
    const reg = makeRegistry();
    await reg.record(snapshot({ headRefOid: "sha-1" }), { chatId: "c1" });
    await reg.notePolicy(REPO, 42, { maxRounds: 4, problem: "no account" });
    const before = events.filter((e) => e.type === "pr-record-update").length;

    await reg.notePolicy(REPO, 42, { maxRounds: 4, problem: "no account" });
    expect(events.filter((e) => e.type === "pr-record-update").length).toBe(before);

    await reg.notePolicy(REPO, 42, { maxRounds: 4 });
    expect(events.filter((e) => e.type === "pr-record-update").length).toBe(before + 1);
    expect((await store.getPrRecord(KEY))?.reviewAgent?.problem).toBeUndefined();
  });
});
