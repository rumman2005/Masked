import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HomeScreen } from "../src/components/HomeScreen";
import { SoloSetup, type SoloSetupProps } from "../src/components/SoloSetup";

describe("extracted home surfaces", () => {
  it("keeps the welcome structure, route controls, and accessibility hooks", () => {
    const markup = renderToStaticMarkup(
      createElement(HomeScreen, {
        homeMode: "solo",
        homeNotice: "Choose a route to get started.",
        onPlayWithFriends: () => undefined,
        onPlaySolo: () => undefined,
        children: createElement("div", { id: "friends-entry" }, "entry"),
      }),
    );

    expect(markup).toContain('class="welcome-section"');
    expect(markup).toContain('aria-labelledby="welcome-title"');
    expect(markup).toContain("Assemble your crew.");
    expect(markup).toContain("Play with Friends");
    expect(markup).toContain("Solo setup");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Choose a route to get started.");
    expect(markup).toContain('class="home-art-svg"');
    expect(markup).toContain('id="friends-entry"');
  });

  it("keeps Solo setup labels, validation attributes, choices, and avatars", () => {
    const props: SoloSetupProps = {
      nickname: "You",
      botCount: 3,
      difficulty: "Normal",
      avatar: "default",
      formError: "Please choose a valid name.",
      pendingAction: null,
      onSubmit: () => undefined,
      onNicknameChange: () => undefined,
      onBotCountChange: () => undefined,
      onDifficultyChange: () => undefined,
      onAvatarChange: () => undefined,
      onBackToFriends: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(SoloSetup, props));

    expect(markup).toContain('class="solo-setup-panel"');
    expect(markup).toContain('aria-labelledby="solo-setup-title"');
    expect(markup).toContain("Set up your Solo Showdown");
    expect(markup).toContain('id="solo-nickname"');
    expect(markup).toMatch(/minlength="2"/i);
    expect(markup).toMatch(/maxlength="16"/i);
    expect(markup).toContain("Bot opponents");
    expect(markup).toContain("Easy");
    expect(markup).toContain("Normal");
    expect(markup).toContain("Hard");
    expect(markup).toContain("Default");
    expect(markup).toContain("Ember");
    expect(markup).toContain("Moon");
    expect(markup).toContain("Mint");
    expect((markup.match(/data-avatar-id="human"/g) ?? [])).toHaveLength(4);
    expect(markup).toContain("Please choose a valid name.");
    expect(markup).toContain("Back to live rooms");
  });
});
