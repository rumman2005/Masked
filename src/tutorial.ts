import type { GamePhase } from "../shared/game-protocol";
import type { TutorialStep } from "./components/TutorialOverlay";

export const TUTORIAL_DISMISSED_STORAGE_KEY = "masked.tutorial.dismissed";

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "welcome",
    title: "Find the Mimic",
    body: "Work together to find the one player who is bluffing before the table does.",
    targetId: "tutorial-role-card",
    targetLabel: "the role stage",
  },
  {
    id: "secret-role",
    title: "Check your private role",
    body: "Citizens use their private word as a guide. The Mimic does not see that word and must blend in. Only the private role card above can show what this player is allowed to know.",
    targetId: "tutorial-role-card",
    targetLabel: "your private role card",
  },
  {
    id: "clues",
    title: "Give one clue",
    body: "When the clue phase opens, submit a short clue based only on your private information. Point toward the word without saying it directly.",
    targetId: "tutorial-clue-action",
    targetLabel: "the clue action area",
  },
  {
    id: "discussion",
    title: "Read the table",
    body: "Compare the public clues, follow the discussion, and use the local reactions if you want to signal a thought. Reactions never change the game result.",
    targetId: "tutorial-discussion-panel",
    targetLabel: "clues and discussion",
  },
  {
    id: "voting",
    title: "Choose and confirm",
    body: "Select an eligible suspect card, review your choice, then explicitly confirm the private vote. The server or local engine still validates the action.",
    targetId: "tutorial-voting-panel",
    targetLabel: "the voting controls",
  },
  {
    id: "reveal",
    title: "Watch the reveal",
    body: "If the Mimic is identified, they may get one final guess. Citizens win when the Mimic fails; the Mimic wins by staying hidden or guessing the word correctly. The game engine decides the result.",
    targetId: "tutorial-reveal-panel",
    targetLabel: "the reveal and result stage",
  },
] as const;

export type TutorialStorage = Pick<Storage, "getItem" | "setItem">;

export function readTutorialDismissed(storage: TutorialStorage | null): boolean {
  if (!storage) {
    return false;
  }

  try {
    return storage.getItem(TUTORIAL_DISMISSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markTutorialDismissed(storage: TutorialStorage | null): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(TUTORIAL_DISMISSED_STORAGE_KEY, "true");
  } catch {
    // Local storage can be unavailable in private browsing contexts.
  }
}

export function shouldAutoStartTutorial(
  activeMatch: boolean,
  dismissed: boolean,
  alreadyShownThisSession: boolean,
): boolean {
  return activeMatch && !dismissed && !alreadyShownThisSession;
}

export function tutorialIndexForPhase(phase: GamePhase | undefined): number {
  switch (phase) {
    case "CLUE_SUBMISSION":
      return 2;
    case "DISCUSSION":
      return 3;
    case "VOTING":
    case "REVOTE":
      return 4;
    case "FINAL_GUESS":
    case "ROUND_RESULTS":
    case "MATCH_RESULTS":
      return 5;
    case "ROLE_REVEAL":
    case "LOBBY":
    default:
      return 0;
  }
}
