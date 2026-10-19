import type { ReactNode } from "react";

/**
 * Content for one first-match tutorial stop.
 *
 * `targetId` is a stable hook that the surrounding screen can use to mark the
 * relevant control or panel. `targetLabel` gives players a friendly name for
 * that same context.
 */
export interface TutorialStep {
  id: string;
  title: string;
  body: ReactNode;
  targetLabel?: string;
  targetId?: string;
}

export interface TutorialOverlayProps {
  /** Whether the optional tutorial is currently visible. */
  open: boolean;
  /** The step to present. `stepIndex` is zero-based. */
  step: TutorialStep;
  stepIndex: number;
  stepCount: number;
  /** Keeps the Back control available only when the parent can move backward. */
  canGoBack: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onClose: () => void;
  /** Optional shortcut to the full rules/help surface. */
  onHowToPlay?: () => void;
  className?: string;
}

/**
 * A small, non-blocking tutorial card for online and Solo gameplay.
 *
 * The parent owns progression and persistence. This component deliberately
 * does not claim a modal role, move focus, or intercept gameplay input.
 */
export function TutorialOverlay({
  open,
  step,
  stepIndex,
  stepCount,
  canGoBack,
  onBack,
  onNext,
  onSkip,
  onClose,
  onHowToPlay,
  className,
}: TutorialOverlayProps) {
  if (!open) {
    return null;
  }

  const visibleStepIndex = Math.max(0, stepIndex) + 1;
  const visibleStepCount = Math.max(1, stepCount);
  const isLastStep = visibleStepIndex >= visibleStepCount;
  const targetName = step.targetLabel ?? step.targetId;
  const classes = [
    "tutorial-overlay",
    targetName ? "tutorial-overlay--has-target" : "",
    step.targetId ? "tutorial-overlay--targeted" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const titleId = `tutorial-step-${step.id}-title`;
  const bodyId = `tutorial-step-${step.id}-body`;

  return (
    <aside
      className={classes}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-tutorial-overlay="true"
      data-tutorial-step-id={step.id}
      data-tutorial-step-index={stepIndex}
      data-tutorial-step-count={stepCount}
      data-tutorial-target-id={step.targetId}
      data-tutorial-target-label={step.targetLabel}
      data-tutorial-target={targetName}
    >
      <div className="tutorial-overlay__header">
        <p className="tutorial-overlay__eyebrow">
          Quick start · Step {visibleStepIndex} of {visibleStepCount}
        </p>
        <button
          className="tutorial-overlay__close"
          type="button"
          onClick={onClose}
          aria-label="Close tutorial"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {targetName ? (
        <p
          className="tutorial-overlay__target"
          data-tutorial-target-id={step.targetId}
          data-tutorial-target-label={step.targetLabel}
        >
          Look here: <strong>{targetName}</strong>
        </p>
      ) : null}

      <h2 className="tutorial-overlay__title" id={titleId}>
        {step.title}
      </h2>
      <div className="tutorial-overlay__body" id={bodyId}>
        {step.body}
      </div>

      <p className="tutorial-overlay__live-region" aria-live="polite" aria-atomic="true">
        Tutorial step {visibleStepIndex} of {visibleStepCount}: {step.title}
        {targetName ? ` — look at ${targetName}.` : "."}
      </p>

      <div className="tutorial-overlay__actions">
        <button className="button button-muted" type="button" onClick={onSkip}>
          Skip Tutorial
        </button>
        {onHowToPlay ? (
          <button className="button button-muted" type="button" onClick={onHowToPlay}>
            How to play
          </button>
        ) : null}
        <div className="tutorial-overlay__navigation">
          <button
            className="button button-muted"
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
          >
            Back
          </button>
          <button className="button button-primary" type="button" onClick={onNext}>
            {isLastStep ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </aside>
  );
}

export default TutorialOverlay;
