import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LeaderboardPanel } from "../src/components/LeaderboardPanel";

describe("room leaderboard panel", () => {
  it("shows an empty state before the first completed match", () => {
    const markup = renderToStaticMarkup(createElement(LeaderboardPanel, {}));

    expect(markup).toContain('data-leaderboard-state="empty"');
    expect(markup).toContain("No completed matches yet");
    expect(markup).toContain("Finish a match to start the room standings.");
  });

  it("renders ranked players with wins and optional played totals", () => {
    const markup = renderToStaticMarkup(
      createElement(LeaderboardPanel, {
        entries: [
          { playerId: "p-2", nickname: "Mara", wins: 1, played: 2 },
          { playerId: "p-1", nickname: "Ada", wins: 2, played: 3 },
        ],
      }),
    );

    expect(markup).toContain('data-leaderboard-state="populated"');
    expect(markup).toContain("#1");
    expect(markup).toContain("Ada");
    expect(markup).toContain("Mara");
    expect(markup).toContain("Played");
    expect(markup).toContain("3");
    expect(markup).toContain("2");
  });
});
