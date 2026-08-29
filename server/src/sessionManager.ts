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

type RuntimeRecord = {
  state: "running" | "stopped";
  pty: pty.IPty | null;
  buffer: string;
  cols: number;
  rows: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  nextOutputSeq: number;
  exitPromise: Promise<void> | null;
  resolveExit: (() => void) | null;
};

type SessionManagerEvents = {
  output: [TerminalOutputEvent];
  status: [RuntimeStatus];
};

const maxBufferChars = 2_000_000;
const defaultTerminalSize = { cols: 120, rows: 36 };

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
    exitPromise: null,
    resolveExit: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
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

  constructor(private readonly projectRoot: string) {
    super();
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
    if (existing?.state === "running") {
      throw new HttpError(
        409,
        "TERMINAL_RUNNING",
        `Terminal "${terminalConfig.id}" is already running`,
      );
    }

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

    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: terminalSize.cols,
        rows: terminalSize.rows,
        cwd,
        env: process.env,
      });
    } catch (error) {
      throw new HttpError(
        500,
        "PTY_START_FAILED",
        error instanceof Error ? error.message : "Failed to start PTY",
      );
    }

    const record: RuntimeRecord = {
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
      exitPromise,
      resolveExit,
    };

    sessionRecords.set(terminalConfig.id, record);

    terminal.onData((data) => {
      const activeRecord = this.records.get(session.id)?.get(terminalConfig.id);
      if (!activeRecord) {
        return;
      }
      const outputAt = now();
      activeRecord.buffer += data;
      if (activeRecord.buffer.length > maxBufferChars) {
        activeRecord.buffer = activeRecord.buffer.slice(-maxBufferChars);
      }
      activeRecord.lastOutputAt = outputAt;
      const seq = activeRecord.nextOutputSeq;
      activeRecord.nextOutputSeq += 1;
      this.emit("output", {
        sessionId: session.id,
        terminalId: terminalConfig.id,
        data,
        at: outputAt,
        seq,
      });
    });

    terminal.onExit(({ exitCode }) => {
      const activeRecord = this.records.get(session.id)?.get(terminalConfig.id);
      if (!activeRecord) {
        return;
      }
      activeRecord.state = "stopped";
      activeRecord.pty = null;
      activeRecord.stoppedAt = now();
      activeRecord.exitCode = exitCode;
      activeRecord.pid = null;
      activeRecord.resolveExit?.();
      activeRecord.resolveExit = null;
      this.emit("status", this.getStatus(session.id, terminalConfig.id));
    });

    this.emit("status", this.getStatus(session.id, terminalConfig.id));
    return this.getStatus(session.id, terminalConfig.id);
  }

  async stop(sessionId: string, terminalId: string): Promise<RuntimeStatus> {
    const record = this.records.get(sessionId)?.get(terminalId);
    if (!record || record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId, terminalId);
    }

    record.pty.kill();
    await Promise.race([record.exitPromise ?? Promise.resolve(), delay(2000)]);
    return this.getStatus(sessionId, terminalId);
  }

  async stopSession(sessionId: string): Promise<void> {
    const terminalIds = [...(this.records.get(sessionId)?.keys() ?? [])];
    await Promise.all(
      terminalIds.map((terminalId) => this.stop(sessionId, terminalId)),
    );
  }

  async deleteSessionRuntime(sessionId: string): Promise<void> {
    try {
      await this.stopSession(sessionId);
    } finally {
      this.records.delete(sessionId);
    }
  }

  deleteTerminalRuntime(sessionId: string, terminalId: string): void {
    const sessionRecords = this.records.get(sessionId);
    sessionRecords?.delete(terminalId);
    if (sessionRecords?.size === 0) {
      this.records.delete(sessionId);
    }
  }

  write(sessionId: string, terminalId: string, data: string): void {
    const record = this.records.get(sessionId)?.get(terminalId);
    if (!record || record.state !== "running" || !record.pty) {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${terminalId}" is not running`,
      );
    }
    record.pty.write(data);
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
  }

  private ensureSessionRecords(sessionId: string): Map<string, RuntimeRecord> {
    let sessionRecords = this.records.get(sessionId);
    if (!sessionRecords) {
      sessionRecords = new Map<string, RuntimeRecord>();
      this.records.set(sessionId, sessionRecords);
    }
    return sessionRecords;
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
