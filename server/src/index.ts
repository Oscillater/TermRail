import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultTerminalId,
  terminalSizeLimits,
  type TerminalSize,
} from "@termrail/shared";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { authMiddleware } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { HttpError } from "./errors.js";
import { listDirectoryRoots, listSubdirectories } from "./filesystem.js";
import { SessionManager } from "./sessionManager.js";
import type { SessionConfig, TerminalConfig } from "./types.js";
import { attachWebSocketServer } from "./ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const configPath = process.env.CONFIG_PATH
  ? resolve(process.env.CONFIG_PATH)
  : resolve(projectRoot, "data", "config.json");

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const authToken = process.env.AUTH_TOKEN?.trim() ?? "";

function asyncRoute(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}

function validatePort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
}

function isLocalHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function optionalStartSize(value: unknown): TerminalSize | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.cols === undefined && record.rows === undefined) {
    return undefined;
  }

  if (
    typeof record.cols !== "number" ||
    typeof record.rows !== "number" ||
    !Number.isInteger(record.cols) ||
    !Number.isInteger(record.rows) ||
    record.cols < terminalSizeLimits.minCols ||
    record.rows < terminalSizeLimits.minRows ||
    record.cols > terminalSizeLimits.maxCols ||
    record.rows > terminalSizeLimits.maxRows
  ) {
    throw new HttpError(
      400,
      "INVALID_TERMINAL_SIZE",
      "start size must include integer cols and rows within supported limits",
    );
  }

  return { cols: record.cols, rows: record.rows };
}

async function main(): Promise<void> {
  validatePort(port);

  const configStore = new ConfigStore(configPath);
  await configStore.load();

  const sessionManager = new SessionManager(projectRoot);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  function getSessionOrThrow(sessionId: string): SessionConfig {
    const session = configStore.getSession(sessionId);
    if (!session) {
      throw new HttpError(
        404,
        "SESSION_NOT_FOUND",
        `Session "${sessionId}" was not found`,
      );
    }
    return session;
  }

  function getTerminalOrThrow(
    session: SessionConfig,
    terminalId: string,
  ): TerminalConfig {
    const terminal = session.terminals.find((item) => item.id === terminalId);
    if (!terminal) {
      throw new HttpError(
        404,
        "TERMINAL_NOT_FOUND",
        `Terminal "${terminalId}" was not found`,
      );
    }
    return terminal;
  }

  function runtimePayload(sessions: SessionConfig[]) {
    return {
      statuses: Object.fromEntries(
        sessions.map((session) => [
          session.id,
          sessionManager.getSessionStatus(session),
        ]),
      ),
      terminalStatuses: Object.fromEntries(
        sessions.map((session) => [
          session.id,
          sessionManager.getTerminalStatuses(session),
        ]),
      ),
    };
  }

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.use("/api", authMiddleware(authToken));

  app.get("/api/sessions", (_request, response) => {
    const sessions = configStore.listSessions();
    response.json({
      prompts: configStore.listPrompts(),
      sessions,
      ...runtimePayload(sessions),
    });
  });

  app.get("/api/prompts", (_request, response) => {
    response.json({ prompts: configStore.listPrompts() });
  });

  app.put(
    "/api/prompts",
    asyncRoute(async (request, response) => {
      const prompts = await configStore.updatePrompts(request.body);
      response.json({ prompts });
    }),
  );

  app.get(
    "/api/filesystem/roots",
    asyncRoute(async (_request, response) => {
      response.json({ roots: await listDirectoryRoots(projectRoot) });
    }),
  );

  app.get(
    "/api/filesystem/directories",
    asyncRoute(async (request, response) => {
      const path =
        typeof request.query.path === "string" ? request.query.path : "";
      response.json(await listSubdirectories(projectRoot, path));
    }),
  );

  app.post(
    "/api/sessions",
    asyncRoute(async (request, response) => {
      const session = await configStore.createSession(request.body);
      response.status(201).json({ session });
    }),
  );

  app.patch(
    "/api/sessions/:id",
    asyncRoute(async (request, response) => {
      const session = await configStore.updateSession(
        request.params.id,
        request.body,
      );
      response.json({ session });
    }),
  );

  app.put(
    "/api/sessions/:id",
    asyncRoute(async (request, response) => {
      const session = await configStore.updateSession(
        request.params.id,
        request.body,
      );
      response.json({ session });
    }),
  );

  app.delete(
    "/api/sessions/:id",
    asyncRoute(async (request, response) => {
      const existing = getSessionOrThrow(request.params.id);
      await sessionManager.deleteSessionRuntime(existing.id);
      const session = await configStore.deleteSession(existing.id);
      response.json({ session });
    }),
  );

  app.get(
    "/api/sessions/:id/terminals",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      response.json({
        terminals: session.terminals,
        statuses: sessionManager.getTerminalStatuses(session),
      });
    }),
  );

  app.post(
    "/api/sessions/:id/terminals",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      const terminal = await configStore.createTerminal(
        session.id,
        request.body,
      );
      const updatedSession = getSessionOrThrow(session.id);
      let terminalStatus;
      try {
        terminalStatus = await sessionManager.start(
          updatedSession,
          terminal,
          optionalStartSize(request.body),
        );
      } catch (error) {
        await configStore
          .deleteTerminal(session.id, terminal.id)
          .catch(() => undefined);
        throw error;
      }

      response.status(201).json({
        session: updatedSession,
        terminal,
        status: terminalStatus,
        sessionStatus: sessionManager.getSessionStatus(updatedSession),
      });
    }),
  );

  app.post(
    "/api/sessions/:id/terminals/:terminalId/start",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      const terminal = getTerminalOrThrow(session, request.params.terminalId);
      const status = await sessionManager.start(
        session,
        terminal,
        optionalStartSize(request.body),
      );
      response.json({
        status,
        sessionStatus: sessionManager.getSessionStatus(session),
      });
    }),
  );

  app.post(
    "/api/sessions/:id/terminals/:terminalId/stop",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      getTerminalOrThrow(session, request.params.terminalId);
      const status = await sessionManager.stop(
        session.id,
        request.params.terminalId,
      );
      response.json({
        status,
        sessionStatus: sessionManager.getSessionStatus(session),
      });
    }),
  );

  app.delete(
    "/api/sessions/:id/terminals/:terminalId",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      getTerminalOrThrow(session, request.params.terminalId);
      await sessionManager.stop(session.id, request.params.terminalId);
      const terminal = await configStore.deleteTerminal(
        session.id,
        request.params.terminalId,
      );
      sessionManager.deleteTerminalRuntime(
        session.id,
        request.params.terminalId,
      );
      const updatedSession = getSessionOrThrow(session.id);
      response.json({
        session: updatedSession,
        terminal,
        sessionStatus: sessionManager.getSessionStatus(updatedSession),
      });
    }),
  );

  app.post(
    "/api/sessions/:id/start",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      const terminal = getTerminalOrThrow(session, defaultTerminalId);
      const terminalStatus = await sessionManager.start(
        session,
        terminal,
        optionalStartSize(request.body),
      );
      response.json({
        status: sessionManager.getSessionStatus(session),
        terminalStatus,
      });
    }),
  );

  app.post(
    "/api/sessions/:id/stop",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      await sessionManager.stopSession(session.id);
      response.json({
        status: sessionManager.getSessionStatus(session),
        terminalStatuses: sessionManager.getTerminalStatuses(session),
      });
    }),
  );

  app.get(
    "/api/sessions/:id/status",
    asyncRoute(async (request, response) => {
      const session = getSessionOrThrow(request.params.id);
      response.json({
        status: sessionManager.getSessionStatus(session),
        terminalStatuses: sessionManager.getTerminalStatuses(session),
      });
    }),
  );

  app.get("/api/status", (_request, response) => {
    response.json(runtimePayload(configStore.listSessions()));
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
        return;
      }

      console.error(error);
      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
    },
  );

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer, authToken, configStore, sessionManager);

  httpServer.listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
    console.log(`[server] config path: ${configPath}`);
    if (authToken) {
      console.log("[server] AUTH_TOKEN is enabled");
    }
    if (!isLocalHost(host)) {
      console.warn(
        "[server] warning: server is not bound to localhost; do not expose it directly to the public internet",
      );
    }
  });

  async function shutdown(): Promise<void> {
    console.log("[server] shutting down");
    await sessionManager.stopAll();
    httpServer.close(() => {
      process.exit(0);
    });
  }

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
