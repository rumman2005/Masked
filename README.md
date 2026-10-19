# MASKED

MASKED is a desktop-first browser social deduction game. The current
implementation includes a React/Vite client, an Express/Socket.IO server, a
real in-memory multiplayer room lobby, a server-authoritative testable game
engine, synchronized round screens, discussion chat, and a transport-free local
Solo Showdown against deterministic bot personalities. The game uses a broad
curated word bank, reveals every final-round role when a match ends, and keeps a
room-scoped leaderboard for groups that play multiple matches together.

## Requirements

- Node.js `22.17.1` (see `.nvmrc`)
- npm

## Setup

```bash
npm ci
```

Copy `.env.example` to `.env` only when local environment overrides are needed.
The defaults use port `3001` for the server and port `5173` for Vite.

For a clean local setup, use the pinned Node.js version and install from the
lockfile:

```bash
nvm use
npm ci
```

Do not commit `.env`; it is ignored. The committed `.env.example` contains the
only supported local overrides.

## Development

Run the client and server together:

```bash
npm run dev
```

Then open <http://localhost:5173>. The page should show `MASKED`, a live
backend connection status, and create/join room controls. The server health
endpoint is available at <http://localhost:3001/health>. Choose **Play Solo**
to open the local setup screen; Solo does not require the backend or create a
room.

To run either process separately:

```bash
npm run dev:server
npm run dev:client
```

The client uses `VITE_SOCKET_URL` when provided and otherwise connects to
`http://localhost:3001`.

## Server-side AI providers

The server includes a provider-neutral routing service with OpenAI-compatible
and native adapters for OpenAI, Groq, NVIDIA NIM, Google Gemini, and Cohere.
Provider credentials are read only by the Node server; never place
these values in `VITE_*` variables or client code. Copy the empty placeholders
from `.env.example` and set only the providers you intend to use:

```dotenv
AI_PROVIDER_CHAIN=gemini,cohere,groq,nvidia-nim
AI_REQUEST_TIMEOUT_MS=30000
AI_MAX_CONCURRENCY=4
AI_BACKOFF_BASE_MS=250
AI_COOLDOWN_MS=10000

OPENAI_API_KEY=
GEMINI_API_KEY=
COHERE_API_KEY=
GROQ_API_KEY=
NVIDIA_NIM_API_KEY=

# Optional model overrides for the providers above:
# GEMINI_MODEL=gemini-2.0-flash
# COHERE_MODEL=command-r-plus
# GROQ_MODEL=llama-3.3-70b-versatile
# NVIDIA_NIM_MODEL=z-ai/glm-5-3-flash
```

`AI_PROVIDER_CHAIN` is comma-separated and is attempted from left to right.
Duplicates and unknown names are ignored. If it is omitted, configured
providers are considered in the stable built-in order. Each provider also
accepts an optional provider-specific `*_MODEL`, `*_BASE_URL`, and
`*_TIMEOUT_MS` override. The defaults are OpenAI's, Groq's, and NVIDIA NIM's
OpenAI-compatible `/chat/completions` endpoints, Gemini's native
`generateContent` endpoint, and Cohere's v2 `chat` endpoint. Missing
credentials leave a provider disabled; no request is made until its
server-side key is set.

The router bounds concurrent requests, applies the configured request timeout,
falls through on provider/network/validation failures, and exponentially backs
off providers after retryable failures. HTTP 429 responses also place a
provider on cooldown and honor a numeric or date-based `Retry-After` header.
When the chain is empty or all remote providers are unavailable, the service
resolves without a completion so the deterministic `SoloAiAgent` remains the
local fallback. Solo uses a small HTTP decision boundary at
`/api/ai/solo-decision`; it accepts only a role-filtered public/private view,
validates the structured response against the current phase, and never sends
provider credentials to the browser. A provider failure, invalid response, or
unreachable server silently returns control to the local agent.

## Solo Showdown

Solo Showdown runs the existing `GameEngine` locally in the browser. It creates
one human seat and `2`–`6` bot seats, with selectable Easy, Normal, or Hard
difficulty and a local avatar choice. Bots use stable personalities, seeded
decisions, short cancellable delays, and contextual discussion messages.

The local controller calls the same authoritative clue, vote, final-guess,
timer, scoring, and rematch methods as the online transport. The human receives
the same private role boundary as an online player: Citizens see the word, while
the Mimic never receives a `secretWord`. Solo never emits Socket.IO room or
game events. Returning to live rooms disposes the local controller and restores
the normal server connection flow.

At the end of an online or Solo match, the finale lists every player in the
decisive final round as a Citizen or the Mimic. Roles are not included in public
game snapshots before the match reaches `MATCH_RESULTS`.

## First-match tutorial

The first active online or Solo match can show a short, skippable tutorial for
the role reveal, clues, discussion, voting, and final reveal. It is a local
browser preference only: **Skip Tutorial**, the close button, or finishing the
last step prevents the automatic prompt from returning, while **How to play**
in the in-game status area can reopen the contextual rules at any time. The
overlay never owns game actions and does not reveal private words or roles.

## Checks

Run the complete offline check after dependencies have been installed:

```bash
npm run check
```

This runs the client/server typechecks, the Vitest suite, and both production
builds. To run only the test suite:

```bash
npm test
```

The current tests check the health response, real Socket.IO client
connections, room capacity and validation, readiness, host authorization,
disconnect/host transfer, reconnect sessions, lobby event broadcasts, role and
secret isolation, phase validation, clues, votes, revotes, final guesses,
timers, scoring, rematches, gameplay disconnects, synchronized socket round
progression, discussion chat validation/rate limiting/clearing, and
host-authorized return to lobby, Solo AI information boundaries and personality
decisions, local Solo phase progression, bot roster limits, difficulty
configuration, timer cancellation, and rematches. The AI tests also cover
provider fallback/cooldown routing, response validation, request privacy, and
concurrency bounds. TypeScript can be checked with:

```bash
npm run typecheck
```

The test suite does not require a browser, external service, database, or
network access. It uses real Socket.IO clients against in-memory server state.

## Rules

- Rooms support `3`–`10` players. The host can start once at least three
  connected players are ready.
- Each match has up to three rounds. The first side to reach two round wins
  ends the match; a three-round tie is reported as a tie.
- At the start of each round, the server assigns one `Mimic` and gives the
  `Citizens` a shared secret word. The Mimic never receives the secret word.
- Every connected player submits one clue. The group then discusses the
  public clues during the timed discussion phase.
- Players secretly vote for an eligible player and cannot vote for themselves.
  A tied vote opens a revote limited to the tied candidates. If the revote is
  still tied, the Mimic wins the round.
- If the group identifies the Mimic, only that Mimic gets one timed final guess.
  A correct guess wins the round for the Mimic; an incorrect guess or timeout
  wins the round for the Citizens. Identifying a Citizen also wins the round
  for the Mimic.
- Default server deadlines are: role reveal `5s`, clues `60s`, discussion
  `45s`, voting `30s`, revote `20s`, final guess `20s`, and round results
  `5s`. The server advances a phase when its deadline or action rules resolve
  it.
- After a match finishes, the room shows a leaderboard ranked by individual
  match wins. A Citizens match win counts for every Citizen in the final round;
  a Mimic match win counts for the Mimic. The leaderboard survives rematches
  and return-to-lobby transitions while the room remains alive.

## Controls

- **Welcome screen:** enter a 2–16 character nickname to create a room, or
  enter a six-character room code and nickname to join one.
- **Lobby:** use **I'm ready** to toggle readiness. The host uses **Start
  game** once the minimum ready count is reached. **Copy invitation** copies
  the room URL and code when the browser permits clipboard access.
- **Clue submission:** type one clue of up to 80 characters and choose
  **Submit clue**.
- **Discussion:** read the public clues, send plain-text chat messages of up
  to 240 characters, and wait for the voting phase.
- **Voting/revote:** select one eligible player and choose **Confirm secret
  vote**.
- **Final guess:** the identified Mimic enters a guess of up to 80 characters
  and chooses **Submit final guess**.
- **Match results:** the host can choose **Play rematch** or **Return to
  lobby**. The finale reveals every final-round role and the room leaderboard.
  Any player can choose **Leave room** while connected.
- **Solo setup:** choose your table name, `2`–`6` bot opponents, Easy/Normal/
  Hard difficulty, and a local avatar. Start a match, submit local clues and
  votes, make a final guess when the Mimic is identified, then choose **Play
  rematch**, **Return to Solo lobby**, or **Leave Solo Showdown**.
- There are no special keyboard shortcuts; all actions are standard buttons,
  text fields, textareas, and radio controls.

## Troubleshooting

- If the page remains disconnected, confirm that the server is running on
  port `3001` and check <http://localhost:3001/health>. Restart `npm run dev`
  after changing `.env`.
- If the browser is opened from another machine, use the host's LAN URL for
  Vite, for example `http://192.168.1.9:5173`. Keep port `3001` reachable by
  the browser; the default client derives the Socket.IO host from the page
  hostname. A firewall may need to allow both ports.
- Set `VITE_SOCKET_URL` in `.env` before starting Vite when the server is on a
  different host or port, for example `VITE_SOCKET_URL=http://localhost:3001`.
- A room is in memory only. Restarting the server invalidates existing rooms
  and saved browser sessions; return to the welcome screen and create a new
  room.
- If an old saved session cannot reconnect, leave the room if possible or
  clear the site's session storage entry `masked.lobby.session`, then reload.
- If a phase appears stuck, verify that the browser connection pill says
  **Connected to game server**. The server owns the phase deadline; reconnect
  or refresh if the connection was interrupted.

## Known limitations

- Rooms, sessions, chat, scores, and game state are in memory only. There is no
  database, account system, matchmaking service, or durable room recovery.
- The leaderboard is scoped to one in-memory room and is lost when that room is
  destroyed or the server restarts; it is not an account-wide leaderboard.
- Solo matches are local to the current browser session and are not persisted.
  The bot roster is deterministic for a given match seed, while each new setup
  starts a fresh seed.
- The compiled server exposes `/health` and Socket.IO. The browser bundle in
  `dist/` is a separate static artifact and must be served by Vite or a static
  web server; configure the build-time `VITE_SOCKET_URL` when the API is not
  reachable at the page host on port `3001`.
- Server CORS intentionally allows localhost and private-network HTTP(S)
  origins for local/LAN play; production deployments should put the API and
  static client behind an appropriate access policy.
- This repository has automated protocol and Socket.IO coverage, but manual
  visual checks still depend on having two browser sessions available.

## Production build and run

Build both browser and server artifacts:

```bash
npm run build
```

The browser output is written to `dist/` and the server output to
`dist-server/`. Start the compiled server with:

```bash
npm start
```

The server listens on `PORT` or defaults to `3001`. Serve `dist/` separately
with a static web server, or use the development Vite server for a local demo.
The client bundle uses `VITE_SOCKET_URL` at build time when it is provided;
otherwise it connects to the page hostname on port `3001`.

### Container deployment

The repository includes a multi-stage `Dockerfile` based on
`node:22.17.1-bookworm-slim`. It installs dependencies from
`package-lock.json`, builds `dist/` and `dist-server/`, then runs the compiled
server with production dependencies:

```bash
docker build -t masked .
docker run --rm -p 3001:3001 masked
```

The container provides the compiled API and Socket.IO server on port `3001`.
Serve the matching `dist/` artifact from the web layer and set
`VITE_SOCKET_URL` before the client build if the API is not at the default
address.
