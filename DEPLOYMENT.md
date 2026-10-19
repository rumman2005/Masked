# MASKED deployment runbook

This runbook describes the supported production shape for MASKED. The project
is an in-memory Node application with a Vite browser bundle and Socket.IO
multiplayer transport. The simplest reliable deployment is one container that
serves the browser, HTTP API, and WebSocket endpoint from one origin.

## Before deploying

1. Use Node.js `22.17.1` for local builds. The version is pinned in `.nvmrc`
   and `package.json`.
2. Install from the committed lockfile with `npm ci`.
3. Run `npm run check`.
4. Confirm `.env` is not staged or tracked:

   ```bash
   git check-ignore .env
   git ls-files .env
   ```

   The first command should print `.env`; the second should print nothing.
5. Rotate any provider key that has been pasted into chat, a ticket, a log, or
   another public location. Put replacement values only in the deployment
   platform's secret manager.

## Deployment model

### Recommended: one service and one origin

The compiled server serves:

- `GET /health` — health/readiness probe.
- `GET /api/ai/status` — provider ids and enabled status; never keys.
- `POST /api/ai/solo-decision` — validated optional Solo bot decisions.
- `/socket.io` — multiplayer lobby and game transport.
- `/` and `/assets/*` — the compiled Vite client when `dist/` is present.

Use one running replica. Rooms, sessions, scores, leaderboards, and Socket.IO
state are held in process memory. Multiple replicas require shared room state,
Socket.IO connection routing, and a coordinated deployment design that this
repository does not provide.

## Local production rehearsal

Build and run the same artifacts used by the container:

```bash
npm ci
npm run check
npm start
```

Open <http://localhost:3001>. `npm start` runs the compiled
`dist-server/server/start.js`; the startup wrapper loads `.env` if present and
the server serves `dist/` when it exists.

To use a different local port without editing files:

```bash
PORT=3010 npm start
```

PowerShell:

```powershell
$env:PORT = "3010"
npm start
```

Check the process from another terminal:

```bash
curl http://localhost:3010/health
```

Expected response:

```json
{"status":"ok"}
```

## Docker deployment

The multi-stage `Dockerfile` uses `node:22.17.1-bookworm-slim`, installs from
`package-lock.json`, builds the browser and server, then runs with production
dependencies only.

Build the image:

```bash
docker build -t masked:latest .
```

Run it locally with a local environment file. This file stays on the host and
is not copied into the image because `.dockerignore` excludes `.env*`:

```bash
docker run --rm --name masked \
  --env-file .env \
  -p 3001:3001 \
  masked:latest
```

Open <http://localhost:3001> and check:

```bash
curl http://localhost:3001/health
```

If the platform assigns a dynamic `PORT`, provide that variable and publish or
route the same container port. The server reads `PORT`; the Dockerfile's
`EXPOSE 3001` documents the default only.

## Deploying to a managed container platform

Render, Railway, Fly.io, Google Cloud Run, Azure Container Apps, and similar
platforms can deploy the repository as a Docker service. The exact dashboard
labels vary, but use this configuration:

| Setting | Value |
| --- | --- |
| Build method | Repository `Dockerfile` |
| Health check | `GET /health` |
| Public service port | The platform-provided `PORT`; default `3001` locally |
| WebSocket support | Enabled; forward `/socket.io` upgrades |
| Replicas | One |
| Persistent disk | Not required; state is intentionally ephemeral |
| Deploy command | Image default: `npm start` via the Dockerfile `CMD` |

Set secrets and variables in the platform configuration, not in Git:

```text
PORT=<platform-provided-port, if required>
AI_PROVIDER_CHAIN=gemini,cohere,groq,nvidia-nim
GEMINI_API_KEY=<secret>
COHERE_API_KEY=<secret>
GROQ_API_KEY=<secret>
NVIDIA_NIM_API_KEY=<secret>
NVIDIA_NIM_MODEL=z-ai/glm-5-3-flash
```

Only set the provider keys and model overrides you actually use. The provider
chain is tried from left to right and the local deterministic Solo AI remains
the fallback when no remote provider is available.

After deployment, verify:

```bash
curl https://your-host.example.com/health
curl https://your-host.example.com/api/ai/status
```

The second response may identify configured providers, but it must never contain
an API key. Open the public URL in a browser and confirm the connection pill
reaches **Connected to game server**. Test a Solo match and a two-browser
multiplayer room before inviting players.

## Split static client and API

Use this model only when a static host must serve the browser separately from
the Node service.

1. Deploy the Node/Docker service as `https://api.example.com`.
2. Set the API service variable:

   ```dotenv
   ALLOWED_ORIGINS=https://app.example.com
   ```

   Use the exact scheme and origin; do not include a path.
3. Build the browser bundle with the public API URL. `VITE_SOCKET_URL` is a
   build-time client value:

   ```bash
   VITE_SOCKET_URL=https://api.example.com npm run build:client
   ```

   PowerShell:

   ```powershell
   $env:VITE_SOCKET_URL = "https://api.example.com"
   npm run build:client
   ```

4. Upload `dist/` to the static host.
5. Configure the reverse proxy to forward WebSocket upgrades for
   `/socket.io`. A static host that only serves HTTP files cannot provide the
   multiplayer transport by itself.
6. Verify `/health`, the browser connection status, Solo, and a multiplayer
   room from the public client origin.

Do not put `GEMINI_API_KEY`, `COHERE_API_KEY`, `GROQ_API_KEY`,
`NVIDIA_NIM_API_KEY`, or any other provider secret in `VITE_*` variables.

## Release checklist

- [ ] `npm ci` completed from `package-lock.json`.
- [ ] `npm run check` passed.
- [ ] `.nvmrc` and `package.json` still require Node `22.17.1`.
- [ ] `.env` and `.opencode/` are ignored and not tracked.
- [ ] No API keys or absolute workstation paths are in the commit.
- [ ] The image was built from the repository `Dockerfile`.
- [ ] `/health` returns HTTP 200.
- [ ] WebSocket upgrade and reconnection work through the proxy.
- [ ] Solo clue, vote, revote, final-guess, results, and rematch flows work.
- [ ] Two separate browser sessions can create, join, ready up, and play.
- [ ] Provider status is checked without exposing credentials.
- [ ] The deployment uses one replica unless shared state is added.
- [ ] The rollback image or previous commit is recorded.

## Operational limitations

MASKED currently has no database, account system, durable room recovery,
cross-process session store, or account-wide leaderboard. Restarting or
redeploying the server ends active rooms and loses in-memory room history. Use
the deployment platform's restart and log tools for process operations, but do
not treat a persistent disk as a substitute for shared application state.
