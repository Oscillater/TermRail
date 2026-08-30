import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { terminalSizeLimits } from "@termrail/shared";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import type {
  RuntimeState,
  RuntimeStatus,
  TerminalOutputEvent,
  TerminalSize,
} from "./types.js";
import { TerminalInputWriter } from "./terminalInputWriter.js";

export type PtyProcess = Pick<
  pty.IPty,
  "pid" | "onData" | "onExit" | "kill" | "write" | "resize"
>;

export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: Parameters<typeof pty.spawn>[2],
) => PtyProcess;

type TerminalRuntimeControllerOptions = {
  sessionId: string;
  terminalId: string;
  projectRoot: string;
  ptySpawn: PtySpawn;
  useConpty?: boolean;
  inputWriter: TerminalInputWriter;
  stopTimeoutMs: number;
  allocateRuntimeId: () => number;
  onOutput: (event: TerminalOutputEvent) => void;
  onStatus: (status: RuntimeStatus) => void;
};

type TerminalRuntimeState =
  "stopped" | "starting" | "running" | "stopping" | "disposed";

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

function externalRuntimeState(state: TerminalRuntimeState): RuntimeState {
  return state === "running" || state === "stopping" ? "running" : "stopped";
}

export class TerminalRuntimeController {
  private runtimeId: number | null = null;
  private state: TerminalRuntimeState = "stopped";
  private pty: PtyProcess | null = null;
  private buffer = "";
  private cols = defaultTerminalSize.cols;
  private rows = defaultTerminalSize.rows;
  private startedAt: string | null = null;
  private stoppedAt: string | null = null;
  private lastOutputAt: string | null = null;
  private exitCode: number | null = null;
  private pid: number | null = null;
  private nextOutputSeq = 1;
  private inputQueue: Promise<void> = Promise.resolve();
  private exitPromise: Promise<void> | null = null;
  private startPromise: Promise<RuntimeStatus> | null = null;
  private stopPromise: Promise<RuntimeStatus> | null = null;

  constructor(private readonly options: TerminalRuntimeControllerOptions) {}

  getStatus(): RuntimeStatus {
    return {
      sessionId: this.options.sessionId,
      terminalId: this.options.terminalId,
      state: externalRuntimeState(this.state),
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastOutputAt: this.lastOutputAt,
      exitCode: this.exitCode,
      pid: this.pid,
      bufferLength: this.buffer.length,
    };
  }

  getBuffer(): string {
    return this.buffer;
  }

  async start({
    cwd,
    command,
    requestedSize,
  }: {
    cwd: string;
    command: string;
    requestedSize?: Partial<TerminalSize>;
  }): Promise<RuntimeStatus> {
    if (this.state === "disposed") {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${this.options.terminalId}" is not running`,
      );
    }

    if (this.state !== "stopped") {
      throw new HttpError(
        409,
        "TERMINAL_RUNNING",
        `Terminal "${this.options.terminalId}" is already running`,
      );
    }

    this.state = "starting";
    const startPromise = this.startInternal({ cwd, command, requestedSize });
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } catch (error) {
      if (this.startPromise === startPromise && this.state === "starting") {
        this.state = "stopped";
      }
      throw error;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  async stop(): Promise<RuntimeStatus> {
    if (this.state === "starting") {
      await this.startPromise?.catch(() => undefined);
    }

    if (this.state === "stopping" && this.stopPromise) {
      return await this.stopPromise;
    }

    if (this.state !== "running" || !this.pty) {
      return this.getStatus();
    }

    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    try {
      return await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") {
      return;
    }

    await this.startPromise?.catch(() => {
      if (this.state === "starting") {
        this.state = "stopped";
      }
    });

    if (this.state === "running" || this.state === "stopping") {
      await this.stop();
    }

    if (
      this.state === "stopped" ||
      (this.state === "starting" && !this.startPromise)
    ) {
      this.state = "disposed";
      this.pty = null;
      this.pid = null;
      this.exitPromise = null;
      this.stopPromise = null;
    }
  }

  write(data: string): Promise<void> {
    if (this.state !== "running" || !this.pty) {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${this.options.terminalId}" is not running`,
      );
    }
    const terminal = this.pty;
    const processId = this.pid;
    const runtimeId = this.runtimeId;
    this.inputQueue = this.inputQueue
      .then(async () => {
        if (runtimeId === null || !this.isActiveRuntime(runtimeId, terminal)) {
          return;
        }

        await this.options.inputWriter.write({
          terminal,
          processId,
          data,
          sessionId: this.options.sessionId,
          terminalId: this.options.terminalId,
          isCurrent: () => this.isActiveRuntime(runtimeId, terminal),
        });
      })
      .catch((error: unknown) => {
        console.warn(
          `[server] terminal input failed for ${this.options.sessionId}/${this.options.terminalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return this.inputQueue;
  }

  resize(cols: number, rows: number): RuntimeStatus {
    if (this.state === "disposed") {
      throw new HttpError(
        409,
        "TERMINAL_NOT_RUNNING",
        `Terminal "${this.options.terminalId}" is not running`,
      );
    }

    const size = normalizeTerminalSize({ cols, rows });
    this.cols = size.cols;
    this.rows = size.rows;
    if (this.state !== "running" || !this.pty) {
      return this.getStatus();
    }

    this.pty.resize(size.cols, size.rows);
    return this.getStatus();
  }

  private async stopInternal(): Promise<RuntimeStatus> {
    const terminal = this.pty;
    const runtimeId = this.runtimeId;
    const exitPromise = this.exitPromise;
    if (this.state !== "running" || !terminal) {
      return this.getStatus();
    }

    this.state = "stopping";
    terminal.kill();

    const exited = await waitForExit(exitPromise, this.options.stopTimeoutMs);
    if (
      !exited &&
      runtimeId !== null &&
      this.isActiveRuntime(runtimeId, terminal)
    ) {
      this.state = "running";
      throw new HttpError(
        409,
        "PTY_STOP_TIMEOUT",
        `Terminal "${this.options.terminalId}" did not stop within ${this.options.stopTimeoutMs}ms`,
      );
    }
    return this.getStatus();
  }

  private async startInternal({
    cwd,
    command,
    requestedSize,
  }: {
    cwd: string;
    command: string;
    requestedSize?: Partial<TerminalSize>;
  }): Promise<RuntimeStatus> {
    const resolvedCwd = await this.resolveCwd(cwd);
    const { file, args } = shellForCommand(command);
    const startedAt = now();
    const terminalSize = normalizeTerminalSize(
      requestedSize ?? {
        cols: this.cols,
        rows: this.rows,
      },
    );

    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });

    let terminal: PtyProcess;
    try {
      terminal = this.options.ptySpawn(file, args, {
        name: "xterm-256color",
        cols: terminalSize.cols,
        rows: terminalSize.rows,
        cwd: resolvedCwd,
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

    const runtimeId = this.options.allocateRuntimeId();
    this.runtimeId = runtimeId;
    this.state = "running";
    this.pty = terminal;
    this.buffer = "";
    this.cols = terminalSize.cols;
    this.rows = terminalSize.rows;
    this.startedAt = startedAt;
    this.stoppedAt = null;
    this.lastOutputAt = null;
    this.exitCode = null;
    this.pid = terminal.pid;
    this.inputQueue = Promise.resolve();
    this.exitPromise = exitPromise;
    this.stopPromise = null;

    terminal.onData((data) => {
      if (!this.isActiveRuntime(runtimeId, terminal)) {
        return;
      }
      const outputAt = now();
      this.buffer += data;
      if (this.buffer.length > maxBufferChars) {
        this.buffer = this.buffer.slice(-maxBufferChars);
      }
      this.lastOutputAt = outputAt;
      const seq = this.nextOutputSeq;
      this.nextOutputSeq += 1;
      this.options.onOutput({
        sessionId: this.options.sessionId,
        terminalId: this.options.terminalId,
        data,
        at: outputAt,
        seq,
      });
    });

    terminal.onExit(({ exitCode }) => {
      resolveExit?.();
      resolveExit = null;
      if (!this.isActiveRuntime(runtimeId, terminal)) {
        return;
      }
      this.state = "stopped";
      this.pty = null;
      this.stoppedAt = now();
      this.exitCode = exitCode;
      this.pid = null;
      this.exitPromise = null;
      this.options.onStatus(this.getStatus());
    });

    this.options.onStatus(this.getStatus());
    return this.getStatus();
  }

  private isActiveRuntime(runtimeId: number, terminal: PtyProcess): boolean {
    return (
      this.runtimeId === runtimeId &&
      this.pty === terminal &&
      (this.state === "running" || this.state === "stopping")
    );
  }

  private async resolveCwd(cwd: string): Promise<string> {
    const resolved = isAbsolute(cwd)
      ? cwd
      : resolve(this.options.projectRoot, cwd);
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
