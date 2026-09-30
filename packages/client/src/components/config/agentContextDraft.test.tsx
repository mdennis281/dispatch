/**
 * The agent-context pane must START from what is already in `project.yaml`.
 *
 * `saveProjectAgentContext` replaces the block WHOLE. So a pane whose draft
 * starts empty is not merely showing stale placeholders — it is loaded with a
 * silent delete: open a project that authored `houseRulesLimit: 3000`, click
 * the mode toggle, press Save, and the 3000 is gone from the file with nothing
 * said and the project quietly back on the app default.
 *
 * The rendered value is the observable end of that bug: a field showing blank
 * when the file says 3000 is exactly the state whose Save destroys it. Asserting
 * the seeded values catches the cause.
 *
 * Static markup rather than a DOM test: the client's vitest runs in a `node`
 * environment (see `vitest.config.ts`), same as `reviewerRoster.test.tsx`. That
 * also means the `useEffect`s never fire, so this renders without a network.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectAgentContext } from "@dispatch/shared";
import { AgentContextPane } from "./AgentContextPane.js";

const render = (saved: ProjectAgentContext | null): string =>
  renderToStaticMarkup(<AgentContextPane projectId="p1" hasConfigDir saved={saved} />);

describe("the agent-context pane's draft", () => {
  it("seeds every override from the saved block, not just the ones it can guess", () => {
    const html = render({
      houseRulesLimit: 3000,
      memory: { surfaceLimit: 10, fullLimit: 4, charBudget: 9000 },
    });
    expect(html).toContain('value="3000"');
    expect(html).toContain('value="10"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="9000"');
  });

  it("leaves a field blank only when the project genuinely authored nothing", () => {
    // Blank is a real answer here — it means "inherit" — so it has to be
    // reachable, and distinguishable from the bug above by the file's contents
    // rather than by what the pane happens to render.
    const html = render(null);
    expect(html).not.toContain('value="3000"');
    // The inherited value is offered as a placeholder, never as a value: a
    // placeholder that round-tripped as a pin would turn every default into an
    // override the first time somebody pressed Save.
    expect(html).toContain('placeholder="1000"');
    expect(html).toContain('placeholder="6"');
  });

  it("shows the authored mode rather than the resolved one", () => {
    // `GET /api/house-rules` reports the RESOLVED mode — "append" whether the
    // project chose it or chose nothing — so seeding from it would pin a
    // default. The manifest block is the only honest source.
    expect(render({ houseRulesMode: "replace" })).toContain("Instead of");
    const off = render(null);
    expect(off).toContain("Alongside");
    expect(off).toContain("Instead of");
  });
});
