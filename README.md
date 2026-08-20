# Codex Switchboard

Minimal local Web tool for switching between configured terminal sessions.

The `server/` workspace exposes the configured session API and PTY WebSocket, and the `web/` workspace provides a Vite/React terminal UI for selecting, starting, stopping, and interacting with sessions.

## Setup

```powershell
npm install
```

## Run

```powershell
npm run dev:server
```

Or start both the backend and the frontend:

```powershell
npm run dev
```

The backend defaults to `http://127.0.0.1:8787`.

## Verify

```powershell
npm run check
npm run smoke --workspace server
```

The smoke test starts a temporary backend on `127.0.0.1:8797`, loads `data/config.example.json`, subscribes over WebSocket, starts the safe `node -v` session, and verifies PTY output.

Optional environment variables:

- `HOST`, default `127.0.0.1`
- `PORT`, default `8787`
- `AUTH_TOKEN`, optional token required by HTTP API and WebSocket when set
- `CONFIG_PATH`, optional override for `data/config.json`
- `SWITCHBOARD_SHELL`, optional shell override for PTY commands
- `VITE_AUTH_TOKEN`, optional frontend token; set it to the same value as `AUTH_TOKEN` when using the Vite dev UI with auth enabled

## Config

Runtime config is stored in `data/config.json`. If the file is missing, the server creates:

```json
{
  "sessions": []
}
```

You can copy `data/config.example.json` to `data/config.json` for safe PTY smoke tests. Relative `cwd` values are resolved from the repository root.

## HTTP API

If `AUTH_TOKEN` is set, pass either `Authorization: Bearer <token>`, `x-auth-token: <token>`, or `?token=<token>`.

- `GET /api/sessions`
- `POST /api/sessions`
- `PATCH /api/sessions/:id`
- `PUT /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/start`
- `POST /api/sessions/:id/stop`
- `GET /api/sessions/:id/status`
- `GET /api/status`

Create or update body:

```json
{
  "id": "test-node-version",
  "name": "Node Version Test",
  "cwd": ".",
  "command": "node -v",
  "prompts": []
}
```

There is no arbitrary command execution endpoint. Start only runs the `command` stored in the session config.

## WebSocket

Connect to `ws://127.0.0.1:8787/ws`. If `AUTH_TOKEN` is set, use `ws://127.0.0.1:8787/ws?token=<token>`.

Client messages:

```json
{ "type": "subscribe", "sessionId": "test-node-version" }
```

```json
{ "type": "unsubscribe", "sessionId": "test-node-version" }
```

```json
{ "type": "input", "sessionId": "test-node-version", "data": "hello\r" }
```

```json
{ "type": "resize", "sessionId": "test-node-version", "cols": 120, "rows": 32 }
```

Server messages include:

- `subscribed`
- `unsubscribed`
- `terminal.output`
- `session.status`
- `error`
