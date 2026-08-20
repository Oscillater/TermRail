# Codex Switchboard TODO

## Goal

Build a minimal local web hub for switching between multiple Codex sessions, without project management features.

The tool should replace several scattered PowerShell windows with one browser UI that can:

- start configured Codex sessions
- switch between live terminals
- show unread activity
- store per-session prompt examples
- copy, insert, or send prompt examples

## Non-Goals

- No kanban board
- No project status tracking
- No task management
- No Git UI
- No file browser
- No MCP integration
- No Codex app-server integration
- No multi-agent orchestration
- No automatic project reasoning
- No cloud sync

## Tech Stack

- Frontend: Vite + React + TypeScript
- Terminal UI: xterm.js
- Backend: Node.js + TypeScript
- HTTP server: Fastify or Express
- Realtime transport: WebSocket
- PTY runner: node-pty
- Storage: JSON file first, SQLite later only if needed

## Data Model

### Session

```ts
type SessionConfig = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  prompts: PromptExample[];
};
```

### Prompt Example

```ts
type PromptExample = {
  id: string;
  title: string;
  text: string;
};
```

## MVP

### 1. Project Setup

- Create a simple two-folder structure:
  - `server/`
  - `web/`
- Add TypeScript config.
- Add lint and format scripts.
- Add a dev script that starts backend and frontend.

### 2. Config Storage

- Store sessions in `data/config.json`.
- Load config on server startup.
- Save config after session or prompt edits.
- Validate required fields:
  - `id`
  - `name`
  - `cwd`
  - `command`
  - `prompts`

### 3. Session Management

- Add API to list configured sessions.
- Add API to create, edit, and delete session configs.
- Add API to start a session.
- Add API to stop a session.
- Keep one PTY process per active session.
- Prevent duplicate PTY processes for the same session.
- Run each session command in its configured `cwd`.

### 4. Terminal Streaming

- Use `node-pty` to spawn the configured command.
- Use WebSocket to stream PTY output to the frontend.
- Send frontend input back to the PTY.
- Resize the PTY when the browser terminal resizes.
- Keep terminal buffer per active session while the server is running.

### 5. Frontend Layout

- Left sidebar: session list.
- Center pane: xterm.js terminal.
- Right pane: prompt examples.
- Add session button.
- Edit session button.
- Start/stop indicator.
- Unread badge for inactive sessions.

### 6. Prompt Examples

- Per-session prompt list starts empty.
- Add, edit, and delete prompt examples in the UI.
- Prompt actions:
  - `Copy`: copy text to clipboard.
  - `Insert`: paste text into current terminal input.
  - `Send`: send text plus newline to current Codex session.

### 7. Unread Activity

- Track the active selected session in the frontend.
- If an inactive session receives output:
  - increment unread count
  - show badge in sidebar
- Clear unread count when switching to that session.

### 8. Notifications

- Ask browser notification permission.
- If an inactive session receives output:
  - show browser notification
- Add setting to enable or disable notifications.
- Keep notification text minimal:
  - `<session name> has new output`

### 9. Security

- Default backend bind address: `127.0.0.1`.
- Add optional auth token for remote access.
- Do not expose arbitrary command execution API.
- Only run commands saved in session config.
- Display warning if bind address is not localhost.
- Recommend Tailscale or LAN access instead of public internet exposure.

## First Usable Version Criteria

- I can add three Codex sessions manually.
- I can start each session from the browser.
- I can switch between live terminals.
- I can type into the selected Codex session.
- I can add prompt examples manually.
- I can send a saved prompt to the current session.
- I can see unread badges when another session outputs text.
- I can receive browser notifications for inactive sessions.

## Later Ideas

- Session auto-start on app launch.
- Session grouping or tags.
- Global prompt examples shared across sessions.
- Import/export config.
- Better mobile layout.
- PWA install support.
- ntfy, Telegram, or Bark notification integration.
- Optional SQLite storage.
- Detect "waiting for input" from terminal output.
- Detect "task complete" heuristically.
- Scan existing Codex sessions.
- One-click `codex resume --last` helper.
