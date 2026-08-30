import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { terminalSizeLimits } from "@termrail/shared";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import type {
  RuntimeStatus,
  SessionConfig,
  TerminalConfig,
  TerminalOutputEvent,
  TerminalSize,
} from "./types.js";
import {
  isWindowsConsoleInputRetrySafe,
  shouldUseWindowsConsoleInput,
  WindowsConsoleInput,
} from "./windowsConsoleInput.js";

type PtyProcess = Pick<
  pty.IPty,
  "pid" | "onData" | "onExit" | "kill" | "write" | "resize"
>;

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: Parameters<typeof pty.spawn>[2],
) => PtyProcess;

type WindowsConsoleInputWriter = Pick<
  WindowsConsoleInput,
  "start" | "write" | "dispose"
>;

type SessionManagerOptions = {
  useConpty?: boolean;
  useWindowsConsoleInput?: boolean;
  ptySpawn?: PtySpawn;
  windowsConsoleInput?: WindowsConsoleInputWriter | null;
  stopTimeoutMs?: number;
};

type RuntimeRecord = {
  runtimeId: number | null;
  state: "running" | "stopped";
  pty: PtyProcess | null;
  buffer: string;
  cols: number;
  rows: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  nextOutputSeq: number;
  inputQueue: Promise<void>;
  exitPromise: Promise<void> | null;
  resolveExit: (() => void) | null;
  windowsConsoleInputDisabled: boolean;
};

type SessionManagerEvents = {
  output: [TerminalOutputEvent];
  status: [RuntimeStatus];
};

const maxBufferChars = 2_000_000;
const defaultTerminalSize = { cols: 120, rows: 36 };
const defaultStopTimeoutMs = 2_000;

function now(): string {
  return new Date().toISOString();
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeTerminalSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: clampValue(
      size?.cols ?? defaultTerminalSize.cols,
      terminalSizeLimits.minCols,
      terminalSizeLimits.maxCols,
    ),
    rows: clampValue(
      size?.rows ?? defaultTerminalSize.rows,
      terminalSizeLimits.minRows,
      terminalSizeLimits.maxRows,
    ),
  };
}

function stoppedRecord(size: TerminalSize): RuntimeRecord {
  return {
    runtimeId: null,
    state: "stopped",
    pty: null,
    buffer: "",
    cols: size.cols,
    rows: size.rows,
    startedAt: null,
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: null,
    nextOutputSeq: 1,
    inputQueue: Promise.resolve(),
    exitPromise: null,
    resolveExit: null,
    windowsConsoleInputDisabled: false,
  };
}

async function waitForExit(
  exitPromise: Promise<void> | null,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    exitPromise
      ? exitPromise.then(() => true as const)
      : new Promise<true>(() => undefined),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return exited;
}

function shellForCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = process.env.TERMRAIL_SHELL || "powershell.exe";
    return {
      file,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    };
  }

  return {
    file: process.env.SHELL || "/bin/sh",
    args: ["-lc", command],
  };
}

function timestampFromIso(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

function latestIso(left: string | null, right: string | null): string | null {
  return timestampFromIso(left) >= timestampFromIso(right) ? left : right;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly records = new Map<string, Map<string, RuntimeRecord>>();
  private readonly startingTerminals = new Set<string>();
  private readonly ptySpawn: PtySpawn;
  private readonly windowsConsoleInput: WindowsConsoleInputWriter | null;
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
    const record = this.records.get(sessionId)?.get(terminalId);
    if (!record) {
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

    return {
      sessionId,
      terminalId,
      state: record.state,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      lastOutputAt: record.lastOutputAt,
      exitCode: record.exitCode,
      pid: record.pid,
      bufferLength: record.buffer.length,
    };
  }

  getBuffer(sessionId: string, terminalId: string): string {
    return this.records.get(sessionId)?.get(terminalId)?.buffer ?? "";
  }

  async start(
    session: SessionConfig,
    terminalConfig: TerminalConfig,
    requestedSize?: Partial<TerminalSize>,
  ): Promise<RuntimeStatus> {
    const sessionRecords = this.ensureSessionRecords(session.id);
    const existing = sessionRecords.get(terminalConfig.id);
    const terminalKey = `${session.id}\u0000${terminalConfig.id}`;
    if (
      existing?.state === "running" ||
      this.startingTerminals.has(terminalKey)
    ) {
      throw new HttpError(
        409,
        "TERMINAL_RUNNING",
        `Terminal "${terminalConfig.id}" is already running`,
      );
    }

    this.startingTerminals.add(terminalKey);
    try {
      const cwd = await this.resolveCwd(session.cwd);
      const { file, args } = shellForCommand(terminalConfig.command);
      const startedAt = now();
      const terminalSize = normalizeTerminalSize(
        requestedSize ?? {
          cols: existing?.cols,
          rows: existing?.rows,
        },
      );

      let resolveExit: (() => void) | null = null;
      const exitPromise = new Promise<void>((resolvePromise) => {
        resolveExit = resolvePromise;
      });

      let terminal: PtyProcess;
      try {
        terminal = this.ptySpawn(file, args, {
          name: "xterm-256color",
          cols: terminalSize.cols,
          rows: terminalSize.rows,
          cwd,
          env: process.env,
          useConpty: this.options.useConpty,
        });
      } catch (error) {
        throw new HttpError(
          500,
          "PTY_START_FAILED",
          error instanceof Error ? error.message : "Failed to start PTY",
        );
      }

      const runtimeId = this.nextRuntimeId;
      this.nextRuntimeId += 1;
      const record: RuntimeRecord = {
        runtimeId,
        state: "running",
        pty: terminal,
        buffer: "",
        cols: terminalSize.cols,
        rows: terminalSize.rows,
        startedAt,
        stoppedAt: null,
        lastOutputAt: null,
        exitCode: null,
        pid: terminal.pid,
        nextOutputSeq: existing?.nextOutputSeq ?? 1,
        inputQueue: Promise.resolve(),
        exitPromise,
        resolveExit,
        windowsConsoleInputDisabled: false,
      };

      sessionRecords.set(terminalConfig.id, record);

      terminal.onData((data) => {
        if (
          !this.isActiveRuntime(
            session.id,
            terminalConfig.id,
            record,
            runtimeId,
            terminal,
          )
        ) {
          return;
        }
        const outputAt = now();
        record.buffer += data;
        if (record.buffer.length > maxBufferChars) {
          record.buffer = record.buffer.slice(-maxBufferChars);
        }
        record.lastOutputAt = outputAt;
        const seq = record.nextOutputSeq;
        record.nextOutputSeq += 1;
        this.emit("output", {
          sessionId: session.id,
          terminalId: terminalConfig.id,
          data,
          at: outputAt,
          seq,
        });
      });

      terminal.onExit(({ exitCode }) => {
        record.resolveExit?.();
        record.resolveExit = null;
        record.exitPromise = null;
        if (
          !this.isActiveRuntime(
            session.id,
            terminalConfig.id,
            record,
            runtimeId,
            terminal,
          )
        ) {
          return;
        }
        record.state = "stopped";
        record.pty = null;
        record.stoppedAt = now();
        record.exitCode = exitCode;
        record.pid = null;
        this.emit("status", this.getStatus(session.id, terminalConfig.id));
      });

      this.emit("status", this.getStatus(session.id, terminalConfig.id));
      return this.getStatus(session.id, terminalConfig.id);
    } finally {
      this.startingTerminals.delete(terminalKey);
    }
  }

  async stop(sessionId: string, terminalId: string): Promise<RuntimeStatus> {
    const record = this.records.get(sessionId)?.get(terminalId);
    if (!record || record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId, terminalId);
    }

    const terminal = record.pty;
    const runtimeId = record.runtimeId;
    const exitPromise = record.exitPromise;
    terminal.kill();
    const exited = await waitForExit(exitPromise, this.stopTimeoutMs);
    if (
      !exited &&
      runtimeId !== null &&
      this.isActiveRuntime(sessionId, terminalId, record, runtimeId, terminal)
    ) {
      throw new HttpError(
        409,
        "PTY_STOP_TIMEOUT",
        `Terminal "${terminalId}" did not stop within ${this.stopTimeoutMs}ms`,
      );
    }
    return this.getStatus(sessionId, terminalId);
  }

  async stopSession(sessionId: string): Promise<void> {
    const terminalIds = [...(this.records.get(sessionId)?.keys() ?? [])];
    await Promise.all(
      terminalIds.map((terminalId) => this.stop(sessionId, terminalId)),
    );
  }

  async deleteSessionRuntime(sessionId: string): Promise<void> {
    const sessionRecords = this.records.get(sessionId);
    await this.stopSession(sessionId);
    if (this.records.get(sessionId) === sessionRecords) {
      this.records.delete(sessionId);
    }
  }

  async deleteTerminalRuntime(
    sessionId: string,
    terminalId: string,
  ): Promise<void> {
    const sessionRecords = this.records.get(sessionId);
    const record = sessionRecords?.get(terminalId);
    await this.stop(sessionId, terminalId);
    if (sessionRecords && sessionRecords.get(terminalId) === record) {
      sessionRecords.delete(terminalId);
    }
    if (sessionRecords?.size === 0) {
      this.records.delete(sessionId);
    }
  }

  write(sessionId: string, terminalId: string, data: string): Promise<void> {
    const record = this.records.get(sessionId)?.get(terminalId);
    if (!record || record.state !== "running" || !record.pty) {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${terminalId}" is not running`,
      );
    }
    const windowsConsoleInput = this.windowsConsoleInput;
    if (!windowsConsoleInput || record.pid === null) {
      record.pty.write(data);
      return Promise.resolve();
    }

    const terminal = record.pty;
    const processId = record.pid;
    const runtimeId = record.runtimeId;
    record.inputQueue = record.inputQueue
      .then(async () => {
        if (
          runtimeId === null ||
          !this.isActiveRuntime(
            sessionId,
            terminalId,
            record,
            runtimeId,
            terminal,
          )
        ) {
          return;
        }

        if (
          record.windowsConsoleInputDisabled ||
          !shouldUseWindowsConsoleInput(data)
        ) {
          terminal.write(data);
          return;
        }

        try {
          await windowsConsoleInput.write(processId, data);
          this.logConsoleInputSuccess();
        } catch (error) {
          const retrySafe = isWindowsConsoleInputRetrySafe(error);
          if (
            this.isActiveRuntime(
              sessionId,
              terminalId,
              record,
              runtimeId,
              terminal,
            )
          ) {
            record.windowsConsoleInputDisabled = true;
            if (retrySafe) {
              terminal.write(data);
            }
          }
          if (retrySafe) {
            this.logConsoleInputFallback(error);
          } else {
            this.logConsoleInputUnknown(error, sessionId, terminalId);
          }
        }
      })
      .catch((error: unknown) => {
        console.warn(
          `[server] terminal input failed for ${sessionId}/${terminalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return record.inputQueue;
  }

  resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): RuntimeStatus {
    const size = normalizeTerminalSize({ cols, rows });
    const sessionRecords = this.ensureSessionRecords(sessionId);
    let record = sessionRecords.get(terminalId);
    if (!record) {
      record = stoppedRecord(size);
      sessionRecords.set(terminalId, record);
    }

    record.cols = size.cols;
    record.rows = size.rows;
    if (record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId, terminalId);
    }

    record.pty.resize(size.cols, size.rows);
    return this.getStatus(sessionId, terminalId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.records.keys()].map((sessionId) => this.stopSession(sessionId)),
    );
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

  private ensureSessionRecords(sessionId: string): Map<string, RuntimeRecord> {
    let sessionRecords = this.records.get(sessionId);
    if (!sessionRecords) {
      sessionRecords = new Map<string, RuntimeRecord>();
      this.records.set(sessionId, sessionRecords);
    }
    return sessionRecords;
  }

  private isActiveRuntime(
    sessionId: string,
    terminalId: string,
    record: RuntimeRecord,
    runtimeId: number,
    terminal: PtyProcess,
  ): boolean {
    return (
      this.records.get(sessionId)?.get(terminalId) === record &&
      record.runtimeId === runtimeId &&
      record.pty === terminal &&
      record.state === "running"
    );
  }

  private async resolveCwd(cwd: string): Promise<string> {
    const resolved = isAbsolute(cwd) ? cwd : resolve(this.projectRoot, cwd);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw new HttpError(
        400,
        "INVALID_CWD",
        `cwd does not exist or is not a directory: ${cwd}`,
      );
    }
    await access(resolved, constants.R_OK);
    return resolved;
  }
}
