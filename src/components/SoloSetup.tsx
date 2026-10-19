import type { FormEvent } from "react";

import type { SoloAiDifficulty } from "../../shared/solo-ai-engine";
import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
} from "../../shared/protocol";
import { Avatar } from "./Avatar";

export type SoloAvatarId = "default" | "ember" | "moon" | "mint";
export type SoloSetupPendingAction = "start" | "rematch" | null;

const SOLO_AVATARS: readonly {
  id: SoloAvatarId;
  label: string;
}[] = [
  { id: "default", label: "Default" },
  { id: "ember", label: "Ember" },
  { id: "moon", label: "Moon" },
  { id: "mint", label: "Mint" },
];

const SOLO_DIFFICULTIES: readonly {
  id: SoloAiDifficulty;
  label: string;
  description: string;
}[] = [
  { id: "Easy", label: "Easy", description: "More uncertain reads and safer mistakes." },
  { id: "Normal", label: "Normal", description: "The balanced MASKED table." },
  { id: "Hard", label: "Hard", description: "Sharper evidence and fewer risky guesses." },
];

export interface SoloSetupProps {
  nickname: string;
  botCount: number;
  difficulty: SoloAiDifficulty;
  avatar: SoloAvatarId;
  formError: string | null;
  pendingAction: SoloSetupPendingAction;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onNicknameChange: (nickname: string) => void;
  onBotCountChange: (botCount: number) => void;
  onDifficultyChange: (difficulty: SoloAiDifficulty) => void;
  onAvatarChange: (avatar: SoloAvatarId) => void;
  onBackToFriends: () => void;
}

export function SoloSetup({
  nickname,
  botCount,
  difficulty,
  avatar,
  formError,
  pendingAction,
  onSubmit,
  onNicknameChange,
  onBotCountChange,
  onDifficultyChange,
  onAvatarChange,
  onBackToFriends,
}: SoloSetupProps) {
  return (
    <section className="solo-setup-panel" aria-labelledby="solo-setup-title">
      <div className="solo-setup-heading">
        <div className="solo-setup-heading-copy">
          <p className="section-kicker">Local table · no room code</p>
          <h2 id="solo-setup-title">Set up your Solo Showdown</h2>
          <p>
            Practice the same hidden-role rules against distinct bot personalities.
            Your role and word stay local to this browser.
          </p>
        </div>
        <span className="local-mode-badge">
          <span aria-hidden="true">●</span> Offline ready
        </span>
      </div>

      <form className="solo-setup-form" onSubmit={onSubmit}>
        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="solo-setup-grid">
          <div className="solo-setup-field solo-nickname-field">
            <label className="field-label" htmlFor="solo-nickname">
              Your table name
            </label>
            <input
              id="solo-nickname"
              className="text-input"
              type="text"
              value={nickname}
              onChange={(event) => onNicknameChange(event.target.value)}
              minLength={NICKNAME_MIN_LENGTH}
              maxLength={NICKNAME_MAX_LENGTH}
              autoComplete="nickname"
              aria-describedby="solo-nickname-hint"
              required
            />
            <p id="solo-nickname-hint" className="field-hint">
              Shown beside your local avatar.
            </p>
          </div>

          <div className="solo-setup-field">
            <label className="field-label" htmlFor="solo-bot-count">
              Bot opponents
            </label>
            <select
              id="solo-bot-count"
              className="text-input solo-select"
              value={botCount}
              onChange={(event) => onBotCountChange(Number(event.target.value))}
              aria-describedby="solo-bot-count-hint"
            >
              {[2, 3, 4, 5, 6].map((count) => (
                <option value={count} key={count}>
                  {count} bots · {count + 1} at the table
                </option>
              ))}
            </select>
            <p id="solo-bot-count-hint" className="field-hint">
              Every match has at least three players.
            </p>
          </div>
        </div>

        <fieldset className="solo-choice-fieldset">
          <legend className="field-label">Difficulty</legend>
          <div className="solo-choice-grid solo-difficulty-grid">
            {SOLO_DIFFICULTIES.map((difficultyOption) => (
              <label
                className={`solo-choice-card ${difficulty === difficultyOption.id ? "is-selected" : ""}`}
                key={difficultyOption.id}
              >
                <input
                  type="radio"
                  name="solo-difficulty"
                  value={difficultyOption.id}
                  checked={difficulty === difficultyOption.id}
                  onChange={() => onDifficultyChange(difficultyOption.id)}
                />
                <span className="solo-choice-copy">
                  <strong>{difficultyOption.label}</strong>
                  <small>{difficultyOption.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="solo-choice-fieldset">
          <legend className="field-label">Your avatar</legend>
          <div className="solo-choice-grid solo-avatar-grid">
            {SOLO_AVATARS.map((avatarOption) => (
              <label
                className={`solo-avatar-choice ${avatar === avatarOption.id ? "is-selected" : ""}`}
                key={avatarOption.id}
              >
                <input
                  type="radio"
                  name="solo-avatar"
                  value={avatarOption.id}
                  checked={avatar === avatarOption.id}
                  onChange={() => onAvatarChange(avatarOption.id)}
                />
                <Avatar
                  avatarId="human"
                  size="chat"
                  states={avatar === avatarOption.id ? "selected" : undefined}
                  className={`solo-avatar-swatch solo-avatar-${avatarOption.id}`}
                  decorative
                />
                <span>{avatarOption.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="solo-setup-actions">
          <button className="button button-primary" type="submit" disabled={pendingAction !== null}>
            {pendingAction === "start" ? "Opening table…" : "Start Solo Showdown"}
          </button>
          <button className="button button-secondary" type="button" onClick={onBackToFriends}>
            Back to live rooms
          </button>
        </div>
      </form>
    </section>
  );
}

export default SoloSetup;
