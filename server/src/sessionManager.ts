import { EventEmitter } from "node:events";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { terminalSizeLimits } from "@termrail/shared";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import type {
  RuntimeStatus,
  SessionConfig,
  TerminalSize,
  TerminalOutputEvent,
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

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly records = new Map<string, RuntimeRecord>();

  constructor(private readonly projectRoot: string) {
    super();
  }

  getStatus(sessionId: string): RuntimeStatus {
    const record = this.records.get(sessionId);
    if (!record) {
      return {
        sessionId,
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
      state: record.state,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      lastOutputAt: record.lastOutputAt,
      exitCode: record.exitCode,
      pid: record.pid,
      bufferLength: record.buffer.length,
    };
  }

  getBuffer(sessionId: string): string {
    return this.records.get(sessionId)?.buffer ?? "";
  }

  async start(
    session: SessionConfig,
    requestedSize?: Partial<TerminalSize>,
  ): Promise<RuntimeStatus> {
    const existing = this.records.get(session.id);
    if (existing?.state === "running") {
      throw new HttpError(
        409,
        "SESSION_RUNNING",
        `Session "${session.id}" is already running`,
      );
    }

    const cwd = await this.resolveCwd(session.cwd);
    const { file, args } = shellForCommand(session.command);
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

    this.records.set(session.id, record);

    terminal.onData((data) => {
      const activeRecord = this.records.get(session.id);
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
      this.emit("output", { sessionId: session.id, data, at: outputAt, seq });
    });

    terminal.onExit(({ exitCode }) => {
      const activeRecord = this.records.get(session.id);
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
      this.emit("status", this.getStatus(session.id));
    });

    this.emit("status", this.getStatus(session.id));
    return this.getStatus(session.id);
  }

  async stop(sessionId: string): Promise<RuntimeStatus> {
    const record = this.records.get(sessionId);
    if (!record || record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId);
    }

    record.pty.kill();
    await Promise.race([record.exitPromise ?? Promise.resolve(), delay(2000)]);
    return this.getStatus(sessionId);
  }

  write(sessionId: string, data: string): void {
    const record = this.records.get(sessionId);
    if (!record || record.state !== "running" || !record.pty) {
      throw new HttpError(
        409,
        "SESSION_NOT_RUNNING",
        `Session "${sessionId}" is not running`,
      );
    }
    record.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): RuntimeStatus {
    const size = normalizeTerminalSize({ cols, rows });
    let record = this.records.get(sessionId);
    if (!record) {
      record = stoppedRecord(size);
      this.records.set(sessionId, record);
    }

    record.cols = size.cols;
    record.rows = size.rows;
    if (record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId);
    }

    record.pty.resize(size.cols, size.rows);
    return this.getStatus(sessionId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.records.keys()].map((sessionId) => this.stop(sessionId)),
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
