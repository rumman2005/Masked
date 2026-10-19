import type { ComponentPropsWithoutRef } from "react";

export const QUICK_REACTIONS = [
  { id: "thinking", label: "Thinking", emoji: "🤔" },
  { id: "surprised", label: "Surprised", emoji: "😮" },
  { id: "laughing", label: "Laughing", emoji: "😂" },
  { id: "clap", label: "Clap", emoji: "👏" },
] as const;

export type QuickReaction = (typeof QUICK_REACTIONS)[number]["id"];

type QuickReactionsContainerProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "aria-label" | "children" | "className" | "role"
>;

export interface QuickReactionsProps extends QuickReactionsContainerProps {
  /** Prevents local reaction selection while the surrounding UI is unavailable. */
  disabled?: boolean;
  /** The reaction currently selected by the surrounding gameplay UI. */
  selectedReaction?: QuickReaction | null;
  /** Reports the selected reaction to the parent without performing side effects. */
  onReact: (reaction: QuickReaction) => void;
  /** Optional local status text announced politely to assistive technology. */
  feedback?: string | null;
  className?: string;
  "aria-label"?: string;
}

/**
 * A compact, local-only reaction control for the MASKED gameplay surface.
 * State and side effects remain with the parent through the typed callback.
 */
export function QuickReactions({
  disabled = false,
  selectedReaction = null,
  onReact,
  feedback,
  className,
  "aria-label": ariaLabel = "Quick reactions",
  ...containerProps
}: QuickReactionsProps) {
  const classes = ["quick-reactions", className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      {...containerProps}
      className={classes}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="quick-reactions__buttons">
        {QUICK_REACTIONS.map(({ id, label, emoji }) => {
          const isSelected = selectedReaction === id;

          return (
            <button
              key={id}
              className={[
                "button",
                "button-small",
                "quick-reactions__button",
                isSelected ? "button-primary is-selected" : "button-muted",
              ].join(" ")}
              type="button"
              onClick={() => onReact(id)}
              disabled={disabled}
              aria-label={label}
              aria-pressed={isSelected}
              data-reaction={id}
              data-selected={isSelected ? "true" : "false"}
            >
              <span aria-hidden="true">{emoji}</span>
              {isSelected ? (
                <span className="quick-reactions__selected-mark" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {feedback ? (
        <p className="quick-reactions__feedback" aria-live="polite" aria-atomic="true">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}

export default QuickReactions;
