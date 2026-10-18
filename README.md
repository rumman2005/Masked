# MASKED

MASKED is a desktop-first browser multiplayer social deduction game. This
repository currently contains the Module 1 bootstrap: a React/Vite client and
an Express/Socket.IO server with a real development connection between them.
Game rules and room mechanics are intentionally not implemented yet.

## Requirements

- Node.js `22.17.1` (see `.nvmrc`)
- npm

## Setup

```bash
npm ci
```

Copy `.env.example` to `.env` only when local environment overrides are needed.
The defaults use port `3001` for the server and port `5173` for Vite.

## Development

Run the client and server together:

```bash
npm run dev
```

Then open <http://localhost:5173>. The page should show `MASKED` and a live
backend connection status. The server health endpoint is available at
<http://localhost:3001/health>.

To run either process separately:

```bash
npm run dev:server
npm run dev:client
```

The client uses `VITE_SOCKET_URL` when provided and otherwise connects to
`http://localhost:3001`.

## Checks

Run the offline test suite after dependencies have been installed:

```bash
npm test
```

The current tests check the health response and a real Socket.IO client
connection. TypeScript can be checked with:

```bash
npm run typecheck
```

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

The server listens on `PORT` or defaults to `3001`.
