import { EventEmitter } from "node:events";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import type {
  RuntimeStatus,
  SessionConfig,
  TerminalOutputEvent,
} from "./types.js";

type RuntimeRecord = {
  state: "running" | "stopped";
  pty: pty.IPty | null;
  buffer: string;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  exitPromise: Promise<void> | null;
  resolveExit: (() => void) | null;
};

type SessionManagerEvents = {
  output: [TerminalOutputEvent];
  status: [RuntimeStatus];
};

const maxBufferChars = 200_000;

function now(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function shellForCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = process.env.SWITCHBOARD_SHELL || "powershell.exe";
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

  async start(session: SessionConfig): Promise<RuntimeStatus> {
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

    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });

    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
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
      startedAt,
      stoppedAt: null,
      lastOutputAt: null,
      exitCode: null,
      pid: terminal.pid,
      exitPromise,
      resolveExit,
    };

    this.records.set(session.id, record);

    terminal.onData((data) => {
      const activeRecord = this.records.get(session.id);
      if (!activeRecord) {
        return;
      }
      activeRecord.buffer += data;
      if (activeRecord.buffer.length > maxBufferChars) {
        activeRecord.buffer = activeRecord.buffer.slice(-maxBufferChars);
      }
      activeRecord.lastOutputAt = now();
      this.emit("output", { sessionId: session.id, data });
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
    const record = this.records.get(sessionId);
    if (!record || record.state !== "running" || !record.pty) {
      return this.getStatus(sessionId);
    }

    record.pty.resize(cols, rows);
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
