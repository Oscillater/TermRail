# TermRail

Run persistent terminal sessions from a local browser dashboard.

TermRail helps you keep project shells, coding agents, and development servers in one place. Each session has a saved working directory and command, runs through a real PTY, streams output over WebSocket, and stays available while you switch between sessions.

## Features

- Start, stop, and switch between named terminal sessions.
- Open multiple terminal tabs inside a session.
- Browser terminal powered by xterm.js and node-pty.
- Live output streaming over WebSocket.
- Activity indicators for sessions producing output in the background.
- Shared prompt library with copy, insert, and send actions.
- Local folder picker for session working directories.
- Large terminal scrollback and server-side buffer retention during runtime.
- Optional token auth for the HTTP API and WebSocket.
- Windows startup script for one-command local launch.

## Use Cases

- Keep several project shells open without juggling terminal windows.
- Run Codex, Claude Code, or other CLI agents in named project sessions.
- Watch background output and jump into active sessions when needed.
- Keep reusable prompts next to the terminal where they are used.

## Current Scope

TermRail is early alpha software for local developer workstations. The current focus is a stable Windows workflow with PowerShell, Node.js, npm, and browser-based terminal switching. macOS and Linux use the same Node/PTY stack.

## Requirements

- Windows, macOS, or Linux.
- Node.js `18.x`, `20.x`, or `22+`.
- npm.
- On Windows, Visual Studio C++ build tools may be required when the `node-pty` prebuilt package is unavailable.

## Quick Start

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

The script checks for Node.js and npm, installs dependencies when `node_modules/` is missing, starts the backend and Vite UI, and opens `http://127.0.0.1:5173`.

### Manual Start

```powershell
npm install
npm start
```

The app runs two local services in development mode:

| Service                   | URL                     |
| ------------------------- | ----------------------- |
| UI                        | `http://127.0.0.1:5173` |
| Backend API and WebSocket | `http://127.0.0.1:8787` |

Vite proxies `/api` and `/ws` to the backend.

## Sessions

Open the UI, choose **Add**, and configure a session with an id, display name, working directory, and command.

```json
{
  "id": "my-project-codex",
  "name": "My Project Codex",
  "cwd": "D:\\Project\\my-project",
  "command": "codex resume",
  "terminals": [
    {
      "id": "main",
      "name": "Main",
      "command": "codex resume"
    }
  ],
  "prompts": []
}
```

More examples:

```json
{
  "id": "my-project-claude",
  "name": "My Project Claude",
  "cwd": "D:\\Project\\my-project",
  "command": "claude",
  "terminals": [
    {
      "id": "main",
      "name": "Main",
      "command": "claude"
    }
  ],
  "prompts": []
}
```

```json
{
  "id": "powershell",
  "name": "PowerShell",
  "cwd": ".",
  "command": "powershell",
  "terminals": [
    {
      "id": "main",
      "name": "Main",
      "command": "powershell"
    }
  ],
  "prompts": []
}
```

Session `cwd` values may be absolute or relative to this repository root.

## Configuration

Runtime config lives at `data/config.json`. Git ignores this file because it can contain private local paths and commands.

An empty config is created automatically:

```json
{
  "prompts": [],
  "sessions": []
}
```

`data/config.example.json` is safe to commit and is used by the smoke test.

You can copy the example file to start from known-good sample sessions:

```powershell
Copy-Item data/config.example.json data/config.json
```

### Session Fields

| Field       | Description                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- |
| `id`        | Stable session id used by the API and WebSocket.                                            |
| `name`      | Display name shown in the UI.                                                               |
| `cwd`       | Working directory for the PTY command.                                                      |
| `command`   | Default command used by legacy start calls and new terminal tabs.                           |
| `terminals` | Persistent terminal tabs for the session. Each tab has `id`, `name`, and `command`.         |
| `prompts`   | Legacy per-session prompt array; the current UI stores the prompt library at the top level. |

## Environment

| Variable          | Default                     | Description                                   |
| ----------------- | --------------------------- | --------------------------------------------- |
| `HOST`            | `127.0.0.1`                 | Backend bind host.                            |
| `PORT`            | `8787`                      | Backend port.                                 |
| `AUTH_TOKEN`      | empty                       | Token accepted by the HTTP API and WebSocket. |
| `CONFIG_PATH`     | `data/config.json`          | Runtime config path override.                 |
| `TERMRAIL_SHELL`  | `powershell.exe` on Windows | PTY shell override used by the server.        |
| `VITE_AUTH_TOKEN` | empty                       | Frontend token for manual Vite startup.       |

When using `start.ps1`, setting `AUTH_TOKEN` is enough; the script mirrors it into `VITE_AUTH_TOKEN` before starting the UI.

## Security Model

TermRail binds to `127.0.0.1` by default and is designed for trusted local environments.

- Saved session configs define the command execution boundary.
- The start endpoint launches the stored `command` for a known session id.
- Directory endpoints return folder listings for selecting a session `cwd`.
- Runtime config stays in `data/config.json`, which is ignored by Git.
- Remote access belongs behind Tailscale, another private VPN, or a trusted LAN.
- Set `AUTH_TOKEN` when binding outside localhost.

## Roadmap

- First-run setup flow for creating the initial sessions from the UI.
- Transcript view with search, copy, clear, and export actions.
- Screenshots and release notes for a public GitHub launch.
- Packaging options after the local development workflow is stable.

## API

When `AUTH_TOKEN` is set, authenticate with one of these options:

- `Authorization: Bearer <token>`
- `x-auth-token: <token>`
- `?token=<token>`

Common HTTP endpoints:

| Method   | Path                                            |
| -------- | ----------------------------------------------- |
| `GET`    | `/api/sessions`                                 |
| `POST`   | `/api/sessions`                                 |
| `PATCH`  | `/api/sessions/:id`                             |
| `DELETE` | `/api/sessions/:id`                             |
| `POST`   | `/api/sessions/:id/start`                       |
| `POST`   | `/api/sessions/:id/stop`                        |
| `GET`    | `/api/sessions/:id/terminals`                   |
| `POST`   | `/api/sessions/:id/terminals`                   |
| `POST`   | `/api/sessions/:id/terminals/:terminalId/start` |
| `POST`   | `/api/sessions/:id/terminals/:terminalId/stop`  |
| `DELETE` | `/api/sessions/:id/terminals/:terminalId`       |
| `GET`    | `/api/status`                                   |
| `GET`    | `/api/filesystem/roots`                         |
| `GET`    | `/api/filesystem/directories?path=<folder>`     |

WebSocket clients connect to `/ws`.

Client messages:

```json
{
  "type": "subscribe",
  "sessionId": "test-node-version",
  "terminalId": "main",
  "includeBuffer": true
}
```

```json
{
  "type": "unsubscribe",
  "sessionId": "test-node-version",
  "terminalId": "main"
}
```

```json
{
  "type": "input",
  "sessionId": "test-node-version",
  "terminalId": "main",
  "data": "hello\r"
}
```

```json
{
  "type": "resize",
  "sessionId": "test-node-version",
  "terminalId": "main",
  "cols": 120,
  "rows": 32
}
```

Set `includeBuffer` to `false` for background activity monitors that only need future output.

Server messages include `subscribed`, `unsubscribed`, `terminal.output`, `terminal.status`, `session.status`, and `error`. `terminal.output` includes an ISO timestamp in `at`.

## Development

```powershell
npm run dev
```

Useful checks:

```powershell
npm run check
npm run format:check
npm run smoke --workspace server
```

The smoke test starts a temporary backend on `127.0.0.1:8797`, loads `data/config.example.json`, subscribes over WebSocket, starts the safe `node -v` session, and verifies PTY output.

## Project Layout

```text
server/   Express API, WebSocket server, PTY session manager
web/      Vite, React, xterm.js terminal UI
data/     Example config and local runtime config location
```

## Troubleshooting

- UI opens and sessions fail to load: confirm the backend is running on `127.0.0.1:8787`.
- `node-pty` install errors on Windows: install Visual Studio C++ build tools or use a supported Node.js version.
- Auth-enabled manual startup: set both `AUTH_TOKEN` and `VITE_AUTH_TOKEN` before running `npm start`.
- TUI size mismatch after startup: use the **Fit** button in the terminal header.
