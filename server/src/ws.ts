import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ConfigStore } from "./configStore.js";
import { HttpError } from "./errors.js";
import { isAuthorized } from "./auth.js";
import type { SessionManager } from "./sessionManager.js";

type ClientMessage =
  | { type: "subscribe"; sessionId: string; includeBuffer: boolean }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

type JsonMessage = Record<string, unknown>;

function isRecord(value: unknown): value is JsonMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    typeof parsed.sessionId !== "string"
  ) {
    throw new HttpError(
      400,
      "INVALID_WS_MESSAGE",
      "WebSocket message must include type and sessionId",
    );
  }

  switch (parsed.type) {
    case "subscribe":
      if (
        parsed.includeBuffer !== undefined &&
        typeof parsed.includeBuffer !== "boolean"
      ) {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "subscribe includeBuffer must be a boolean",
        );
      }
      return {
        type: "subscribe",
        sessionId: parsed.sessionId,
        includeBuffer: parsed.includeBuffer ?? true,
      };
    case "unsubscribe":
      return { type: "unsubscribe", sessionId: parsed.sessionId };
    case "input":
      if (typeof parsed.data !== "string") {
        throw new HttpError(
          400,
          "INVALID_WS_MESSAGE",
          "input message must include string data",
        );
      }
      return { type: "input", sessionId: parsed.sessionId, data: parsed.data };
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
        parsed.cols < 10 ||
        parsed.rows < 3 ||
        parsed.cols > 500 ||
        parsed.rows > 200
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

export function attachWebSocketServer(
  server: Server,
  authToken: string,
  configStore: ConfigStore,
  sessionManager: SessionManager,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<string, Set<WebSocket>>();
  const clientSubscriptions = new WeakMap<WebSocket, Set<string>>();

  function ensureSession(sessionId: string): void {
    if (!configStore.getSession(sessionId)) {
      throw new HttpError(
        404,
        "SESSION_NOT_FOUND",
        `Session "${sessionId}" was not found`,
      );
    }
  }

  function subscribe(
    ws: WebSocket,
    sessionId: string,
    includeBuffer: boolean,
  ): void {
    ensureSession(sessionId);

    let clients = subscriptions.get(sessionId);
    if (!clients) {
      clients = new Set<WebSocket>();
      subscriptions.set(sessionId, clients);
    }
    clients.add(ws);

    let sessions = clientSubscriptions.get(ws);
    if (!sessions) {
      sessions = new Set<string>();
      clientSubscriptions.set(ws, sessions);
    }
    sessions.add(sessionId);

    send(ws, {
      type: "subscribed",
      sessionId,
      status: sessionManager.getStatus(sessionId),
      buffer: includeBuffer ? sessionManager.getBuffer(sessionId) : "",
    });
  }

  function unsubscribe(ws: WebSocket, sessionId: string): void {
    subscriptions.get(sessionId)?.delete(ws);
    clientSubscriptions.get(ws)?.delete(sessionId);
    send(ws, { type: "unsubscribed", sessionId });
  }

  function cleanup(ws: WebSocket): void {
    const sessions = clientSubscriptions.get(ws);
    if (!sessions) {
      return;
    }

    sessions.forEach((sessionId) => {
      subscriptions.get(sessionId)?.delete(ws);
    });
    clientSubscriptions.delete(ws);
  }

  function broadcast(sessionId: string, payload: unknown): void {
    subscriptions.get(sessionId)?.forEach((ws) => send(ws, payload));
  }

  sessionManager.on("output", ({ sessionId, data, at }) => {
    broadcast(sessionId, { type: "terminal.output", sessionId, data, at });
  });

  sessionManager.on("status", (status) => {
    broadcast(status.sessionId, {
      type: "session.status",
      sessionId: status.sessionId,
      status,
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const message = parseClientMessage(raw);
        ensureSession(message.sessionId);

        switch (message.type) {
          case "subscribe":
            subscribe(ws, message.sessionId, message.includeBuffer);
            break;
          case "unsubscribe":
            unsubscribe(ws, message.sessionId);
            break;
          case "input":
            sessionManager.write(message.sessionId, message.data);
            break;
          case "resize":
            send(ws, {
              type: "session.status",
              sessionId: message.sessionId,
              status: sessionManager.resize(
                message.sessionId,
                message.cols,
                message.rows,
              ),
            });
            break;
        }
      } catch (error) {
        sendError(ws, error);
      }
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
