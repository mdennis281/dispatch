/**
 * A switched-off reviewer must still RENDER.
 *
 * The pane reads its list from `resolveWorkflow`, and that resolver has two
 * lists on purpose: `pr.reviewers` is who gets requested (mutes already
 * removed), `pr.reviewerRoster` is the whole list including the muted rows. Read
 * the first one here and a muted reviewer vanishes from the only screen that can
 * switch it back on — no error, no empty state, just a row that is gone and a
 * login to retype exactly right (`[bot]` suffix and all) to recover.
 *
 * Static markup rather than a DOM test: the client's vitest runs in a `node`
 * environment (see `vitest.config.ts`), same as `peerAttribution.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkflowConfig } from "@dispatch/shared";
import { ReviewerSection } from "./ReviewerSection.js";

const render = (wf: WorkflowConfig): string =>
  renderToStaticMarkup(<ReviewerSection value={wf} onChange={() => {}} />);

describe("the reviewer roster pane", () => {
  it("renders a muted reviewer as an off row rather than dropping it", () => {
    const html = render({
      profile: "review",
      pr: { reviewers: ["octocat", { login: "dispatch-review", enabled: false }] },
    });
    expect(html).toContain("dispatch-review");
    // Its switch is the way back, so it has to be there and it has to be off.
    expect(html).toContain('aria-label="Ask dispatch-review again"');
    expect(html).toContain('aria-label="Stop asking octocat"');
  });

  it("warns that nobody is asked when every row is switched off", () => {
    // Distinct from the empty list: the rows are all still there, so "Nobody"
    // on its own would read as a bug rather than as the state you just chose.
    const html = render({
      profile: "review",
      pr: { reviewers: [{ login: "octocat", enabled: false }], requireReview: true },
    });
    expect(html).toContain("Every reviewer here is switched off");
    expect(html).toContain("no-review");
  });

  it("still says Nobody when the list is genuinely empty", () => {
    const html = render({ profile: "review", pr: { reviewers: [] } });
    expect(html).toContain("Nobody.");
    expect(html).not.toContain("Every reviewer here is switched off");
  });
});
