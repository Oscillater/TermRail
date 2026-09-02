import type { Server } from "node:http";
import {
  terminalSizeLimits,
  type TerminalSnapshotMode,
  type WsClientMessage,
} from "@termrail/shared";
import { WebSocket, WebSocketServer } from "ws";
import { isAuthorized } from "./auth.js";
import type { ConfigStore } from "./configStore.js";
import { HttpError } from "./errors.js";
import type { SessionManager } from "./sessionManager.js";

type ClientMessage = WsClientMessage & { terminalId: string };

type JsonMessage = Record<string, unknown>;

function isRecord(value: unknown): value is JsonMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSnapshotMode(value: unknown): TerminalSnapshotMode {
  if (value === undefined) {
    return "tail";
  }
  if (value === "tail" || value === "full") {
    return value;
  }
  throw new HttpError(
    400,
    "INVALID_WS_MESSAGE",
    'snapshot mode must be "tail" or "full"',
  );
}

function parseSnapshotMinSeq(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "INVALID_WS_MESSAGE",
      "snapshot minSeq must be a non-negative integer",
    );
  }
  return value;
}

function parseClientMessage(raw: WebSocket.RawData): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new HttpError(
      400,
      "INVALID_WS_MESSAGE",
      "WebSocket message must be valid JSON",
    );
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.terminalId !== "string" ||
    !parsed.terminalId
  ) {
    throw new HttpError(
      400,
      "INVALID_WS_MESSAGE",
      "WebSocket message must include type, sessionId, and terminalId",
    );
  }

  const terminalId = parsed.terminalId;

  switch (parsed.type) {
    case "subscribe":
      return {
        type: "subscribe",
        sessionId: parsed.sessionId,
        terminalId,
      };
    case "snapshot":
      if (typeof parsed.requestId !== "string" || !parsed.requestId) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "snapshot message must include a requestId",
        );
      }
      if (typeof parsed.cols !== "number" || typeof parsed.rows !== "number") {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "snapshot message must include integer cols and rows",
        );
      }
      if (!Number.isInteger(parsed.cols) || !Number.isInteger(parsed.rows)) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "snapshot message must include integer cols and rows",
        );
      }
      if (
        parsed.cols < terminalSizeLimits.minCols ||
        parsed.rows < terminalSizeLimits.minRows ||
        parsed.cols > terminalSizeLimits.maxCols ||
        parsed.rows > terminalSizeLimits.maxRows
      ) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "snapshot dimensions are out of range",
        );
      }
      return {
        type: "snapshot",
        sessionId: parsed.sessionId,
        terminalId,
        requestId: parsed.requestId,
        cols: parsed.cols,
        rows: parsed.rows,
        mode: parseSnapshotMode(parsed.mode),
        minSeq: parseSnapshotMinSeq(parsed.minSeq),
      };
    case "unsubscribe":
      return { type: "unsubscribe", sessionId: parsed.sessionId, terminalId };
    case "input":
      if (typeof parsed.data !== "string") {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "input message must include string data",
        );
      }
      return {
        type: "input",
        sessionId: parsed.sessionId,
        terminalId,
        data: parsed.data,
      };
    case "resize":
      if (typeof parsed.cols !== "number" || typeof parsed.rows !== "number") {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "resize message must include integer cols and rows",
        );
      }
      if (!Number.isInteger(parsed.cols) || !Number.isInteger(parsed.rows)) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "resize message must include integer cols and rows",
        );
      }
      if (
        parsed.cols < terminalSizeLimits.minCols ||
        parsed.rows < terminalSizeLimits.minRows ||
        parsed.cols > terminalSizeLimits.maxCols ||
        parsed.rows > terminalSizeLimits.maxRows
      ) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "resize dimensions are out of range",
        );
      }
      return {
        type: "resize",
        sessionId: parsed.sessionId,
        terminalId,
        cols: parsed.cols,
        rows: parsed.rows,
      };
    default:
      throw new HttpError(
        400,
        "INVALID_WS_MESSAGE",
        `Unsupported WebSocket message type: ${parsed.type}`,
      );
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws: WebSocket, error: unknown): void {
  if (error instanceof HttpError) {
    send(ws, {
      type: "error",
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  send(ws, {
    type: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
}

function subscriptionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function keySessionId(key: string): string {
  return key.split("\u0000", 1)[0] ?? "";
}

export function attachWebSocketServer(
  server: Server,
  authToken: string,
  configStore: ConfigStore,
  sessionManager: SessionManager,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<string, Set<WebSocket>>();
  const clientSubscriptions = new WeakMap<WebSocket, Set<string>>();

  function ensureTerminal(sessionId: string, terminalId: string): void {
    const session = configStore.getSession(sessionId);
    if (!session) {
      throw new HttpError(
        404,
        "SESSION_NOT_FOUND",
        `Session "${sessionId}" was not found`,
      );
    }

    if (!session.terminals.some((terminal) => terminal.id === terminalId)) {
      throw new HttpError(
        404,
        "TERMINAL_NOT_FOUND",
        `Terminal "${terminalId}" was not found`,
      );
    }
  }

  function subscribe(
    ws: WebSocket,
    sessionId: string,
    terminalId: string,
  ): void {
    ensureTerminal(sessionId, terminalId);

    const key = subscriptionKey(sessionId, terminalId);
    let clients = subscriptions.get(key);
    if (!clients) {
      clients = new Set<WebSocket>();
      subscriptions.set(key, clients);
    }
    clients.add(ws);

    let clientKeys = clientSubscriptions.get(ws);
    if (!clientKeys) {
      clientKeys = new Set<string>();
      clientSubscriptions.set(ws, clientKeys);
    }
    clientKeys.add(key);

    send(ws, {
      type: "subscribed",
      sessionId,
      terminalId,
      status: sessionManager.getStatus(sessionId, terminalId),
    });
  }

  async function snapshot(
    ws: WebSocket,
    sessionId: string,
    terminalId: string,
    requestId: string,
    cols: number,
    rows: number,
    mode: TerminalSnapshotMode,
    minSeq: number | undefined,
  ): Promise<void> {
    ensureTerminal(sessionId, terminalId);
    const terminalSnapshot = await sessionManager.getSnapshot(
      sessionId,
      terminalId,
      { requestedSize: { cols, rows }, mode, minSeq },
    );

    send(ws, {
      type: "terminal.snapshot",
      sessionId,
      terminalId,
      requestId,
      status: terminalSnapshot.status,
      runtimeId: terminalSnapshot.runtimeId,
      format: terminalSnapshot.format,
      mode: terminalSnapshot.mode,
      data: terminalSnapshot.data,
      seq: terminalSnapshot.seq,
      minSeq: terminalSnapshot.minSeq,
      complete: terminalSnapshot.complete,
      cols: terminalSnapshot.cols,
      rows: terminalSnapshot.rows,
      screenRevision: terminalSnapshot.screenRevision,
      bufferType: terminalSnapshot.bufferType,
    });
  }

  function unsubscribe(
    ws: WebSocket,
    sessionId: string,
    terminalId: string,
  ): void {
    const key = subscriptionKey(sessionId, terminalId);
    subscriptions.get(key)?.delete(ws);
    clientSubscriptions.get(ws)?.delete(key);
    send(ws, { type: "unsubscribed", sessionId, terminalId });
  }

  function cleanup(ws: WebSocket): void {
    const clientKeys = clientSubscriptions.get(ws);
    if (!clientKeys) {
      return;
    }

    clientKeys.forEach((key) => {
      subscriptions.get(key)?.delete(ws);
    });
    clientSubscriptions.delete(ws);
  }

  function broadcastTerminal(
    sessionId: string,
    terminalId: string,
    payload: unknown,
  ): void {
    subscriptions
      .get(subscriptionKey(sessionId, terminalId))
      ?.forEach((ws) => send(ws, payload));
  }

  function broadcastSession(sessionId: string, payload: unknown): void {
    const clients = new Set<WebSocket>();
    subscriptions.forEach((subscribers, key) => {
      if (keySessionId(key) !== sessionId) {
        return;
      }
      subscribers.forEach((ws) => clients.add(ws));
    });
    clients.forEach((ws) => send(ws, payload));
  }

  sessionManager.on(
    "output",
    ({ sessionId, terminalId, runtimeId, data, at, seq }) => {
      broadcastTerminal(sessionId, terminalId, {
        type: "terminal.output",
        sessionId,
        terminalId,
        runtimeId,
        data,
        at,
        seq,
      });
    },
  );

  sessionManager.on("screenProgress", (progress) => {
    broadcastTerminal(progress.sessionId, progress.terminalId, {
      type: "terminal.screen-progress",
      ...progress,
    });
  });

  sessionManager.on("status", (status) => {
    const terminalId = status.terminalId;
    if (!terminalId) {
      return;
    }

    broadcastTerminal(status.sessionId, terminalId, {
      type: "terminal.status",
      sessionId: status.sessionId,
      terminalId,
      status,
    });

    const session = configStore.getSession(status.sessionId);
    if (!session) {
      return;
    }
    broadcastSession(status.sessionId, {
      type: "session.status",
      sessionId: status.sessionId,
      status: sessionManager.getSessionStatus(session),
    });
  });

  wss.on("connection", (ws) => {
    const handleMessage = async (raw: WebSocket.RawData) => {
      try {
        const message = parseClientMessage(raw);
        ensureTerminal(message.sessionId, message.terminalId);

        switch (message.type) {
          case "subscribe":
            subscribe(ws, message.sessionId, message.terminalId);
            break;
          case "snapshot":
            await snapshot(
              ws,
              message.sessionId,
              message.terminalId,
              message.requestId,
              message.cols,
              message.rows,
              message.mode ?? "tail",
              message.minSeq,
            );
            break;
          case "unsubscribe":
            unsubscribe(ws, message.sessionId, message.terminalId);
            break;
          case "input":
            sessionManager.write(
              message.sessionId,
              message.terminalId,
              message.data,
            );
            break;
          case "resize":
            send(ws, {
              type: "terminal.status",
              sessionId: message.sessionId,
              terminalId: message.terminalId,
              status: sessionManager.resize(
                message.sessionId,
                message.terminalId,
                message.cols,
                message.rows,
              ),
            });
            break;
        }
      } catch (error) {
        sendError(ws, error);
      }
    };

    ws.on("message", (raw) => {
      void handleMessage(raw);
    });

    ws.on("close", () => cleanup(ws));
    ws.on("error", () => cleanup(ws));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    if (!isAuthorized(request, authToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
}
