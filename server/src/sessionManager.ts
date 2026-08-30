import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import {
  TerminalRuntimeController,
  type PtySpawn,
} from "./terminalRuntimeController.js";
import {
  TerminalInputWriter,
  type WindowsConsoleInputWriter,
} from "./terminalInputWriter.js";
import type {
  RuntimeStatus,
  SessionConfig,
  TerminalConfig,
  TerminalOutputEvent,
  TerminalSize,
} from "./types.js";
import { WindowsConsoleInput } from "./windowsConsoleInput.js";

type SessionManagerOptions = {
  useConpty?: boolean;
  useWindowsConsoleInput?: boolean;
  ptySpawn?: PtySpawn;
  windowsConsoleInput?: WindowsConsoleInputWriter | null;
  stopTimeoutMs?: number;
};

type SessionManagerEvents = {
  output: [TerminalOutputEvent];
  status: [RuntimeStatus];
};

const defaultStopTimeoutMs = 2_000;

function stoppedStatus(sessionId: string, terminalId: string): RuntimeStatus {
  return {
    sessionId,
    terminalId,
    state: "stopped",
    startedAt: null,
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: null,
    bufferLength: 0,
  };
}

function timestampFromIso(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

function latestIso(left: string | null, right: string | null): string | null {
  return timestampFromIso(left) >= timestampFromIso(right) ? left : right;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly controllers = new Map<
    string,
    Map<string, TerminalRuntimeController>
  >();
  private readonly ptySpawn: PtySpawn;
  private readonly windowsConsoleInput: WindowsConsoleInputWriter | null;
  private readonly inputWriter: TerminalInputWriter;
  private readonly stopTimeoutMs: number;
  private nextRuntimeId = 1;
  private loggedConsoleInputFallback = false;
  private loggedConsoleInputUnknown = false;
  private loggedConsoleInputSuccess = false;

  constructor(
    private readonly projectRoot: string,
    private readonly options: SessionManagerOptions = {},
  ) {
    super();
    this.ptySpawn = options.ptySpawn ?? pty.spawn;
    this.stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs;
    this.windowsConsoleInput =
      options.windowsConsoleInput !== undefined
        ? options.windowsConsoleInput
        : options.useWindowsConsoleInput
          ? new WindowsConsoleInput()
          : null;
    void this.windowsConsoleInput?.start().catch((error: unknown) => {
      this.logConsoleInputFallback(error);
    });
    this.inputWriter = new TerminalInputWriter({
      windowsConsoleInput: this.windowsConsoleInput,
      logConsoleInputSuccess: () => this.logConsoleInputSuccess(),
      logConsoleInputFallback: (error) => this.logConsoleInputFallback(error),
      logConsoleInputUnknown: (error, sessionId, terminalId) =>
        this.logConsoleInputUnknown(error, sessionId, terminalId),
    });
  }

  getSessionStatus(session: SessionConfig): RuntimeStatus {
    const statuses = session.terminals.map((terminal) =>
      this.getStatus(session.id, terminal.id),
    );
    const runningStatuses = statuses.filter(
      (status) => status.state === "running",
    );
    const relevantStatuses =
      runningStatuses.length > 0 ? runningStatuses : statuses;
    const newestStatus = [...relevantStatuses].sort(
      (left, right) =>
        timestampFromIso(right.lastOutputAt) -
          timestampFromIso(left.lastOutputAt) ||
        timestampFromIso(right.stoppedAt) - timestampFromIso(left.stoppedAt) ||
        timestampFromIso(right.startedAt) - timestampFromIso(left.startedAt),
    )[0];

    return {
      sessionId: session.id,
      state: runningStatuses.length > 0 ? "running" : "stopped",
      startedAt: latestIso(null, newestStatus?.startedAt ?? null),
      stoppedAt:
        runningStatuses.length > 0
          ? null
          : latestIso(null, newestStatus?.stoppedAt ?? null),
      lastOutputAt: statuses.reduce<string | null>(
        (latest, status) => latestIso(latest, status.lastOutputAt),
        null,
      ),
      exitCode:
        runningStatuses.length > 0 ? null : (newestStatus?.exitCode ?? null),
      pid: runningStatuses[0]?.pid ?? null,
      bufferLength: statuses.reduce(
        (total, status) => total + status.bufferLength,
        0,
      ),
    };
  }

  getTerminalStatuses(session: SessionConfig): Record<string, RuntimeStatus> {
    return Object.fromEntries(
      session.terminals.map((terminal) => [
        terminal.id,
        this.getStatus(session.id, terminal.id),
      ]),
    );
  }

  getStatus(sessionId: string, terminalId: string): RuntimeStatus {
    return (
      this.controllers.get(sessionId)?.get(terminalId)?.getStatus() ??
      stoppedStatus(sessionId, terminalId)
    );
  }

  getBuffer(sessionId: string, terminalId: string): string {
    return this.controllers.get(sessionId)?.get(terminalId)?.getBuffer() ?? "";
  }

  async start(
    session: SessionConfig,
    terminalConfig: TerminalConfig,
    requestedSize?: Partial<TerminalSize>,
  ): Promise<RuntimeStatus> {
    return await this.ensureController(session.id, terminalConfig.id).start({
      cwd: session.cwd,
      command: terminalConfig.command,
      requestedSize,
    });
  }

  async stop(sessionId: string, terminalId: string): Promise<RuntimeStatus> {
    return (
      (await this.controllers.get(sessionId)?.get(terminalId)?.stop()) ??
      this.getStatus(sessionId, terminalId)
    );
  }

  async stopSession(sessionId: string): Promise<void> {
    const controllers = [...(this.controllers.get(sessionId)?.values() ?? [])];
    await Promise.all(controllers.map((controller) => controller.stop()));
  }

  async deleteSessionRuntime(sessionId: string): Promise<void> {
    const sessionControllers = this.controllers.get(sessionId);
    const controllers = [...(sessionControllers?.values() ?? [])];
    await Promise.all(controllers.map((controller) => controller.dispose()));
    if (this.controllers.get(sessionId) === sessionControllers) {
      this.controllers.delete(sessionId);
    }
  }

  async deleteTerminalRuntime(
    sessionId: string,
    terminalId: string,
  ): Promise<void> {
    const sessionControllers = this.controllers.get(sessionId);
    const controller = sessionControllers?.get(terminalId);
    if (controller) {
      await controller.dispose();
    }
    if (
      sessionControllers &&
      sessionControllers.get(terminalId) === controller
    ) {
      sessionControllers.delete(terminalId);
    }
    if (sessionControllers?.size === 0) {
      this.controllers.delete(sessionId);
    }
  }

  write(sessionId: string, terminalId: string, data: string): Promise<void> {
    const controller = this.controllers.get(sessionId)?.get(terminalId);
    if (!controller) {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${terminalId}" is not running`,
      );
    }
    return controller.write(data);
  }

  resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): RuntimeStatus {
    return this.ensureController(sessionId, terminalId).resize(cols, rows);
  }

  async stopAll(): Promise<void> {
    const controllers = [...this.controllers.values()].flatMap(
      (sessionControllers) => [...sessionControllers.values()],
    );
    await Promise.all(controllers.map((controller) => controller.dispose()));
    this.windowsConsoleInput?.dispose();
  }

  private logConsoleInputFallback(error: unknown): void {
    if (this.loggedConsoleInputFallback) {
      return;
    }
    this.loggedConsoleInputFallback = true;
    console.warn(
      `[server] Windows console input helper unavailable; using ConPTY input: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private logConsoleInputUnknown(
    error: unknown,
    sessionId: string,
    terminalId: string,
  ): void {
    if (this.loggedConsoleInputUnknown) {
      return;
    }
    this.loggedConsoleInputUnknown = true;
    console.warn(
      `[server] Windows console input was not acknowledged for ${sessionId}/${terminalId}; the current input was not retried and future input will use ConPTY: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private logConsoleInputSuccess(): void {
    if (this.loggedConsoleInputSuccess) {
      return;
    }
    this.loggedConsoleInputSuccess = true;
    console.log("[server] Windows console input helper acknowledged input");
  }

  private allocateRuntimeId(): number {
    const runtimeId = this.nextRuntimeId;
    this.nextRuntimeId += 1;
    return runtimeId;
  }

  private ensureSessionControllers(
    sessionId: string,
  ): Map<string, TerminalRuntimeController> {
    let sessionControllers = this.controllers.get(sessionId);
    if (!sessionControllers) {
      sessionControllers = new Map<string, TerminalRuntimeController>();
      this.controllers.set(sessionId, sessionControllers);
    }
    return sessionControllers;
  }

  private ensureController(
    sessionId: string,
    terminalId: string,
  ): TerminalRuntimeController {
    const sessionControllers = this.ensureSessionControllers(sessionId);
    let controller = sessionControllers.get(terminalId);
    if (!controller) {
      controller = new TerminalRuntimeController({
        sessionId,
        terminalId,
        projectRoot: this.projectRoot,
        ptySpawn: this.ptySpawn,
        useConpty: this.options.useConpty,
        inputWriter: this.inputWriter,
        stopTimeoutMs: this.stopTimeoutMs,
        allocateRuntimeId: () => this.allocateRuntimeId(),
        onOutput: (event) => this.emit("output", event),
        onStatus: (status) => this.emit("status", status),
      });
      sessionControllers.set(terminalId, controller);
    }
    return controller;
  }
}
