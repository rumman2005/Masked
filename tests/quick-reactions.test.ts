import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { QuickReactions } from "../src/components/QuickReactions";

describe("QuickReactions", () => {
  it("renders local reaction controls with an accessible selected state", () => {
    const markup = renderToStaticMarkup(
      createElement(QuickReactions, {
        selectedReaction: "clap",
        onReact: vi.fn(),
        feedback: "Clap reaction selected. It has no game effect.",
      }),
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Clap reaction selected");
    expect((markup.match(/data-reaction=/g) ?? []).length).toBe(4);
  });
});
