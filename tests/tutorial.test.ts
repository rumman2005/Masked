import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TutorialOverlay } from "../src/components/TutorialOverlay";
import {
  markTutorialDismissed,
  readTutorialDismissed,
  shouldAutoStartTutorial,
  TUTORIAL_DISMISSED_STORAGE_KEY,
  TUTORIAL_STEPS,
  tutorialIndexForPhase,
} from "../src/tutorial";

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("first-match tutorial", () => {
  it("maps each authoritative phase to the next contextual explanation", () => {
    expect(tutorialIndexForPhase("ROLE_REVEAL")).toBe(0);
    expect(tutorialIndexForPhase("CLUE_SUBMISSION")).toBe(2);
    expect(tutorialIndexForPhase("DISCUSSION")).toBe(3);
    expect(tutorialIndexForPhase("VOTING")).toBe(4);
    expect(tutorialIndexForPhase("REVOTE")).toBe(4);
    expect(tutorialIndexForPhase("FINAL_GUESS")).toBe(5);
    expect(tutorialIndexForPhase("MATCH_RESULTS")).toBe(5);
  });

  it("keeps the copy generic and does not disclose a secret word or assigned role", () => {
    expect(TUTORIAL_STEPS).toHaveLength(6);

    for (const step of TUTORIAL_STEPS) {
      const body = String(step.body);
      expect(body).not.toMatch(/ANCHOR|BICYCLE|CANDLE|CASTLE|COMPASS/);
      expect(body).not.toMatch(/you are the (citizen|mimic)/i);
      expect(step.targetId).toBeTruthy();
    }
  });

  it("persists dismissal without preventing manual reopening", () => {
    const storage = createMemoryStorage();

    expect(readTutorialDismissed(storage)).toBe(false);
    markTutorialDismissed(storage);
    expect(storage.getItem(TUTORIAL_DISMISSED_STORAGE_KEY)).toBe("true");
    expect(readTutorialDismissed(storage)).toBe(true);
  });

  it("only auto-starts for an active, non-dismissed first match", () => {
    expect(shouldAutoStartTutorial(true, false, false)).toBe(true);
    expect(shouldAutoStartTutorial(false, false, false)).toBe(false);
    expect(shouldAutoStartTutorial(true, true, false)).toBe(false);
    expect(shouldAutoStartTutorial(true, false, true)).toBe(false);
  });

  it("renders a non-modal, skippable contextual card", () => {
    const markup = renderToStaticMarkup(
      createElement(TutorialOverlay, {
        open: true,
        step: TUTORIAL_STEPS[2],
        stepIndex: 2,
        stepCount: TUTORIAL_STEPS.length,
        canGoBack: true,
        onBack: () => undefined,
        onNext: () => undefined,
        onSkip: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain('data-tutorial-overlay="true"');
    expect(markup).toContain("Skip Tutorial");
    expect(markup).toContain("Next");
    expect(markup).not.toContain('role="dialog"');
  });
});
