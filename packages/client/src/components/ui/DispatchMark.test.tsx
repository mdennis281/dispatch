import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DispatchMark } from "./DispatchMark.js";

const styles = readFileSync(new URL("./DispatchMark.css", import.meta.url), "utf8");

describe("DispatchMark", () => {
  it("renders a transparent graph with stable semantic parts", () => {
    const html = renderToStaticMarkup(<DispatchMark title="Dispatch" />);

    expect(html).not.toContain("<rect");
    expect(html.match(/data-kind="branch"/g)).toHaveLength(3);
    expect(html.match(/data-kind="node"/g)).toHaveLength(3);
    expect(html).toContain('data-part="upper"');
    expect(html).toContain('data-part="junction"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Dispatch"');
  });

  it("exposes motion and per-part color overrides", () => {
    const html = renderToStaticMarkup(
      <DispatchMark
        motion="loading"
        color="currentColor"
        colors={{ upper: "#67b7d1", "upper-tip": "#67b7d1" }}
      />,
    );

    expect(html).toContain('data-motion="loading"');
    expect(html).toContain("--dispatch-mark-color:currentColor");
    expect(html.match(/--dispatch-part-color:#67b7d1/g)).toHaveLength(2);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("holds loading nodes at their hidden first keyframe during stagger delays", () => {
    expect(styles).toMatch(
      /\[data-motion="loading"\] \.dispatch-mark__node\s*\{[^}]*animation-fill-mode:\s*backwards;/s,
    );
  });
});
