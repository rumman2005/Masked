import type { ReactNode } from "react";

export type HomeMode = "friends" | "solo";

export interface HomeScreenProps {
  homeMode: HomeMode;
  homeNotice: string | null;
  onPlayWithFriends: () => void;
  onPlaySolo: () => void;
  children: ReactNode;
}

function HomeCharacterArt() {
  return (
    <svg
      className="home-art-svg"
      viewBox="0 0 520 280"
      role="img"
      aria-label="Two cartoon players hiding behind colorful masks"
    >
      <path
        className="art-sun"
        d="M365 28c39-14 91 6 111 40 20 34 8 82-24 105-32 24-86 23-116-7-30-29-40-90-15-116 12-12 27-18 44-22Z"
      />
      <path
        className="art-table"
        d="M27 246c41-30 105-42 177-36 72 6 133 29 183 25 47-4 83-34 111-25 19 6 25 23 21 42H27c-4-3-4-4 0-6Z"
      />
      <g className="art-purple-player">
        <path
          className="art-purple-body"
          d="M92 244c4-46 26-69 66-69s61 23 65 69H92Z"
        />
        <path
          className="art-purple-hood"
          d="M110 166c-4-52 13-93 51-105 44-14 85 19 85 72 0 25-8 49-24 70l-17-13c8-17 11-36 8-54-5-29-22-47-49-47-26 0-43 16-48 45-3 17 0 36 8 55l-14 14c-12-12-19-25-20-37Z"
        />
        <circle className="art-purple-face" cx="160" cy="134" r="45" />
        <path
          className="art-purple-mask"
          d="M119 126c12-21 29-31 49-31 22 0 39 10 51 31-12 17-29 25-51 25-21 0-37-8-49-25Z"
        />
        <circle className="art-eye" cx="143" cy="126" r="5" />
        <circle className="art-eye" cx="177" cy="126" r="5" />
        <path className="art-smile" d="M147 144c8 6 17 6 25 0" />
        <path className="art-purple-badge" d="M76 214h42v28H76z" />
        <path className="art-badge-star" d="m97 219 4 8 9 1-7 6 2 9-8-4-8 4 2-9-7-6 9-1 4-8Z" />
      </g>
      <g className="art-coral-player">
        <path
          className="art-coral-body"
          d="M272 246c4-58 28-86 72-86 45 0 71 28 75 86H272Z"
        />
        <path
          className="art-coral-hair"
          d="M291 162c-12-38 8-82 49-93 44-11 81 20 81 66 0 18-6 34-16 47l-18-11c6-13 8-27 5-40-5-23-20-37-43-37-25 0-40 17-42 42-1 12 2 25 8 37l-17 11c-4-7-6-14-7-22Z"
        />
        <circle className="art-coral-face" cx="347" cy="127" r="43" />
        <path
          className="art-coral-mask"
          d="M307 120c11-17 25-25 42-25 18 0 32 8 42 25-10 16-24 23-42 23-18 0-32-7-42-23Z"
        />
        <circle className="art-eye" cx="332" cy="119" r="5" />
        <circle className="art-eye" cx="361" cy="119" r="5" />
        <path className="art-smile" d="M335 138c7 5 14 5 21 0" />
        <path className="art-coral-badge" d="M401 191h48v32h-48z" />
        <path className="art-badge-wave" d="M412 207c5-10 10 10 15 0s10 10 15 0" />
      </g>
      <path className="art-spark art-spark-one" d="m257 56 5 12 12 5-12 5-5 12-5-12-12-5 12-5 5-12Z" />
      <path className="art-spark art-spark-two" d="m454 150 4 9 9 4-9 4-4 9-4-9-9-4 9-4 4-9Z" />
      <circle className="art-dot art-dot-one" cx="69" cy="91" r="6" />
      <circle className="art-dot art-dot-two" cx="424" cy="61" r="5" />
    </svg>
  );
}

export function HomeScreen({
  homeMode,
  homeNotice,
  onPlayWithFriends,
  onPlaySolo,
  children,
}: HomeScreenProps) {
  return (
    <section className="welcome-section" aria-labelledby="welcome-title">
      <div className="home-hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">
            <span className="home-eyebrow-dot" aria-hidden="true" />
            Social deduction · live rooms
          </p>
          <h1 id="welcome-title">
            Assemble your crew.
            <span>Trust no mask.</span>
          </h1>
          <p className="home-hero-description">
            Read the clues, spot the imposter, and keep your secret safe. A
            fast party game for the friends who know your tells.
          </p>
          <div className="home-facts" aria-label="Game facts">
            <span><strong>3–10</strong> players</span>
            <span><strong>3</strong> rounds</span>
            <span><strong>1</strong> hidden Mimic</span>
          </div>
        </div>
        <div className="home-art-wrap">
          <HomeCharacterArt />
          <span className="art-sticker art-sticker-one">Who’s bluffing?</span>
          <span className="art-sticker art-sticker-two">Trust issues welcome</span>
        </div>
      </div>

      <div className="mode-heading">
        <div>
          <p className="section-kicker">Choose your mission</p>
          <h2>How will you play?</h2>
        </div>
        <span className="home-mode-note">Pick a route to get started</span>
      </div>

      <div className="mode-grid" aria-label="Play modes">
        <article className={`mode-card mode-card-friends ${homeMode === "friends" ? "is-selected" : ""}`}>
          <div className="mode-card-topline">
            <span className="mode-icon mode-icon-friends" aria-hidden="true">✦</span>
            <span className="mode-tag">Best with a crew</span>
          </div>
          <h3>Play with Friends</h3>
          <p>Create a live room or join your friends with a six-character code.</p>
          <button
            className="mode-action mode-action-friends"
            type="button"
            onClick={onPlayWithFriends}
            aria-pressed={homeMode === "friends"}
          >
            <span>Enter a live room</span>
            <span aria-hidden="true">→</span>
          </button>
        </article>

        <article className={`mode-card mode-card-solo ${homeMode === "solo" ? "is-selected" : ""}`}>
          <div className="mode-card-topline">
            <span className="mode-icon mode-icon-solo" aria-hidden="true">◒</span>
            <span className="mode-tag mode-tag-next">Local play</span>
          </div>
          <h3>Play Solo</h3>
          <p>Practice your tells against distinct bot personalities with the full MASKED rules.</p>
          <button
            className="mode-action mode-action-solo"
            type="button"
            onClick={onPlaySolo}
            aria-pressed={homeMode === "solo"}
          >
            <span>{homeMode === "solo" ? "Solo setup" : "Play Solo"}</span>
            <span aria-hidden="true">↗</span>
          </button>
          <span className="mode-footnote">2–6 bots · Easy, Normal, or Hard</span>
        </article>
      </div>

      {homeNotice ? (
        <p className="home-notice" role="status">
          <span aria-hidden="true">✦</span>
          {homeNotice}
        </p>
      ) : null}

      {children}
    </section>
  );
}

export default HomeScreen;
