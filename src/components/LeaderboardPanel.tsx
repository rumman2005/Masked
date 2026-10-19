import type { PublicLeaderboardEntry } from "../../shared/protocol";

/**
 * The room protocol may add derived standings fields without changing the
 * fields that are required to render the leaderboard. Keeping these optional
 * here lets the UI display older room snapshots as well as richer snapshots.
 */
export interface LeaderboardEntry extends PublicLeaderboardEntry {
  played?: number;
  rank?: number;
}

export interface LeaderboardPanelProps {
  entries?: readonly LeaderboardEntry[];
}

interface RankedLeaderboardEntry extends LeaderboardEntry {
  displayRank: number;
}

function validRank(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function validPlayed(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function rankedEntries(
  entries: readonly LeaderboardEntry[] | undefined,
): RankedLeaderboardEntry[] {
  const safeEntries = (entries ?? []).filter(
    (entry) =>
      typeof entry.playerId === "string" &&
      entry.playerId.length > 0 &&
      typeof entry.nickname === "string" &&
      typeof entry.wins === "number" &&
      Number.isFinite(entry.wins),
  );

  return safeEntries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort(({ entry: left, originalIndex: leftIndex }, { entry: right, originalIndex: rightIndex }) => {
      const leftRank = validRank(left.rank);
      const rightRank = validRank(right.rank);

      if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      if (leftRank !== undefined && rightRank === undefined) {
        return -1;
      }

      if (leftRank === undefined && rightRank !== undefined) {
        return 1;
      }

      if (left.wins !== right.wins) {
        return right.wins - left.wins;
      }

      const leftPlayed = validPlayed(left.played) ?? -1;
      const rightPlayed = validPlayed(right.played) ?? -1;
      if (leftPlayed !== rightPlayed) {
        return rightPlayed - leftPlayed;
      }

      const nicknameOrder = left.nickname.localeCompare(right.nickname);
      return nicknameOrder !== 0 ? nicknameOrder : leftIndex - rightIndex;
    })
    .map(({ entry }, index) => ({
      ...entry,
      displayRank: validRank(entry.rank) ?? index + 1,
    }));
}

export function LeaderboardPanel({ entries }: LeaderboardPanelProps) {
  const rows = rankedEntries(entries);
  const showPlayed = rows.some((entry) => validPlayed(entry.played) !== undefined);

  return (
    <section
      className="leaderboard-panel"
      aria-labelledby="room-leaderboard-title"
      data-leaderboard-state={rows.length === 0 ? "empty" : "populated"}
    >
      <div className="leaderboard-heading">
        <div>
          <p className="section-kicker">Room leaderboard</p>
          <h2 id="room-leaderboard-title">Standings</h2>
        </div>
        <span className="server-truth-note">Live room history</span>
      </div>

      {rows.length === 0 ? (
        <div className="leaderboard-empty" role="status">
          <span className="leaderboard-empty-mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>No completed matches yet</strong>
            <p>Finish a match to start the room standings.</p>
          </div>
        </div>
      ) : (
        <div
          className={`leaderboard-table ${showPlayed ? "has-played" : ""}`}
          role="table"
          aria-label="Room leaderboard standings"
        >
          <div className="leaderboard-table-header" role="row">
            <span role="columnheader">Rank</span>
            <span role="columnheader">Player</span>
            <span role="columnheader">Wins</span>
            {showPlayed ? <span role="columnheader">Played</span> : null}
          </div>
          <ol className="leaderboard-list">
            {rows.map((entry) => (
              <li
                className="leaderboard-row"
                data-player-id={entry.playerId}
                key={entry.playerId}
                role="row"
              >
                <span className="leaderboard-rank" role="cell">
                  #{entry.displayRank}
                </span>
                <span className="leaderboard-player" role="cell">
                  <strong>{entry.nickname}</strong>
                  <small>{validPlayed(entry.played) !== undefined ? "Room competitor" : "Standing"}</small>
                </span>
                <span className="leaderboard-stat" role="cell">
                  <strong>{entry.wins}</strong>
                  <small>win{entry.wins === 1 ? "" : "s"}</small>
                </span>
                {showPlayed ? (
                  <span className="leaderboard-stat leaderboard-played" role="cell">
                    <strong>{validPlayed(entry.played) ?? "—"}</strong>
                    <small>played</small>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

export default LeaderboardPanel;
