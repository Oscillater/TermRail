import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { terminalSizeLimits } from "@termrail/shared";
import type * as SerializeXterm from "@xterm/addon-serialize";
import type * as HeadlessXterm from "@xterm/headless";
import * as pty from "node-pty";
import { HttpError } from "./errors.js";
import type {
  RuntimeState,
  RuntimeStatus,
  TerminalBufferType,
  TerminalOutputEvent,
  TerminalScreenProgress,
  TerminalSnapshotMode,
  TerminalSize,
} from "./types.js";
import { TerminalInputWriter } from "./terminalInputWriter.js";

const require = createRequire(import.meta.url);
const { SerializeAddon } =
  require("@xterm/addon-serialize") as typeof SerializeXterm;
const { Terminal: HeadlessTerminal } =
  require("@xterm/headless") as typeof HeadlessXterm;

type HeadlessTerminalInstance = HeadlessXterm.Terminal;
type SerializeAddonInstance = SerializeXterm.SerializeAddon;

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
  onScreenProgress: (event: TerminalScreenProgress) => void;
  onStatus: (status: RuntimeStatus) => void;
};

type TerminalRuntimeState =
  "stopped" | "starting" | "running" | "stopping" | "disposed";

const maxBufferChars = 2_000_000;
const terminalScrollbackRows = 100_000;
const defaultTerminalSize = { cols: 120, rows: 36 };
const terminalSnapshotFormat = "xterm-serialized-vt" as const;
const snapshotInitialBoundaryWaitMs = 100;
const snapshotMinSeqWaitMs = 750;
const screenWriteCallbackTimeoutMs = 10_000;

export type TerminalRuntimeSnapshotOptions = {
  requestedSize?: Partial<TerminalSize>;
  mode?: TerminalSnapshotMode;
  minSeq?: number | null;
};

export type TerminalRuntimeSnapshot = {
  status: RuntimeStatus;
  runtimeId: number | null;
  format: typeof terminalSnapshotFormat;
  mode: TerminalSnapshotMode;
  data: string;
  seq: number;
  minSeq: number | null;
  complete: boolean;
  cols: number;
  rows: number;
  screenRevision: number;
  bufferType: TerminalBufferType;
};

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

function normalizeSnapshotMode(
  mode: TerminalSnapshotMode | undefined,
): TerminalSnapshotMode {
  return mode ?? "tail";
}

function normalizeSnapshotMinSeq(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
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

function shellForCommand(command: string): {
  file: string;
  args: string[];
  interactive: boolean;
} {
  const trimmedCommand = command.trim();
  if (process.platform === "win32") {
    const file = process.env.TERMRAIL_SHELL || "powershell.exe";
    return {
      file,
      args: trimmedCommand
        ? [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            trimmedCommand,
          ]
        : [],
      interactive: !trimmedCommand,
    };
  }

  return {
    file: process.env.SHELL || "/bin/sh",
    args: trimmedCommand ? ["-lc", trimmedCommand] : [],
    interactive: !trimmedCommand,
  };
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "TermRail",
  };
  delete env.NO_COLOR;
  return env;
}

function externalRuntimeState(state: TerminalRuntimeState): RuntimeState {
  return state === "running" || state === "stopping" ? "running" : "stopped";
}

export class TerminalRuntimeController {
  private runtimeId: number | null = null;
  private state: TerminalRuntimeState = "stopped";
  private pty: PtyProcess | null = null;
  private screen: HeadlessTerminalInstance | null = null;
  private serializer: SerializeAddonInstance | null = null;
  private pendingScreenData = "";
  private pendingScreenSeq = 0;
  private pendingScreenResize: TerminalSize | null = null;
  private screenFlushImmediate: NodeJS.Immediate | null = null;
  private screenFlushInProgress = false;
  private screenFlushGeneration = 0;
  private screenBoundaryWaiters: Array<() => void> = [];
  private lastSnapshotDataByMode: Record<TerminalSnapshotMode, string> = {
    tail: "",
    full: "",
  };
  private lastSnapshotRuntimeIdByMode: Record<
    TerminalSnapshotMode,
    number | null
  > = {
    tail: null,
    full: null,
  };
  private lastSnapshotSeqByMode: Record<TerminalSnapshotMode, number> = {
    tail: 0,
    full: 0,
  };
  private lastSnapshotColsByMode: Record<TerminalSnapshotMode, number> = {
    tail: defaultTerminalSize.cols,
    full: defaultTerminalSize.cols,
  };
  private lastSnapshotRowsByMode: Record<TerminalSnapshotMode, number> = {
    tail: defaultTerminalSize.rows,
    full: defaultTerminalSize.rows,
  };
  private lastSnapshotRevisionByMode: Record<TerminalSnapshotMode, number> = {
    tail: 0,
    full: 0,
  };
  private lastSnapshotBufferTypeByMode: Record<
    TerminalSnapshotMode,
    TerminalBufferType
  > = {
    tail: "normal",
    full: "normal",
  };
  private lastSnapshotValidByMode: Record<TerminalSnapshotMode, boolean> = {
    tail: false,
    full: false,
  };
  private buffer = "";
  private cols = defaultTerminalSize.cols;
  private rows = defaultTerminalSize.rows;
  private startedAt: string | null = null;
  private stoppedAt: string | null = null;
  private lastOutputAt: string | null = null;
  private exitCode: number | null = null;
  private pid: number | null = null;
  private nextOutputSeq = 1;
  private latestOutputSeq = 0;
  private screenAppliedSeq = 0;
  private screenRevision = 0;
  private screenBufferType: TerminalBufferType = "normal";
  private screenBaseY = 0;
  private screenRowFingerprints: number[] = [];
  private inputQueue: Promise<void> = Promise.resolve();
  private exitPromise: Promise<void> | null = null;
  private startPromise: Promise<RuntimeStatus> | null = null;
  private stopPromise: Promise<RuntimeStatus> | null = null;
  private useWindowsConsoleInputForRuntime = true;

  constructor(private readonly options: TerminalRuntimeControllerOptions) {}

  getStatus(): RuntimeStatus {
    return {
      sessionId: this.options.sessionId,
      terminalId: this.options.terminalId,
      runtimeId: this.runtimeId,
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

  async getSnapshot(
    options: TerminalRuntimeSnapshotOptions = {},
  ): Promise<TerminalRuntimeSnapshot> {
    const runtimeId = this.runtimeId;
    const mode = normalizeSnapshotMode(options.mode);
    if (runtimeId === null || !this.screen) {
      return {
        status: this.getStatus(),
        runtimeId: null,
        format: terminalSnapshotFormat,
        mode,
        data: "",
        seq: 0,
        minSeq: null,
        complete: true,
        cols: this.cols,
        rows: this.rows,
        screenRevision: 0,
        bufferType: "normal",
      };
    }
    const minSeq =
      normalizeSnapshotMinSeq(options.minSeq) ?? this.latestOutputSeq;
    this.scheduleScreenFlush();
    await this.waitForSnapshotBoundary(
      runtimeId,
      minSeq,
      minSeq > 0 ? snapshotMinSeqWaitMs : snapshotInitialBoundaryWaitMs,
    );
    this.captureSnapshotAtBoundary(runtimeId, mode);
    const hasSnapshot =
      this.lastSnapshotValidByMode[mode] &&
      this.lastSnapshotRuntimeIdByMode[mode] === runtimeId;
    const seq = hasSnapshot
      ? this.lastSnapshotSeqByMode[mode]
      : this.screenAppliedSeq;

    return {
      status: this.getStatus(),
      runtimeId: hasSnapshot
        ? this.lastSnapshotRuntimeIdByMode[mode]
        : this.runtimeId,
      format: terminalSnapshotFormat,
      mode,
      data: hasSnapshot ? this.lastSnapshotDataByMode[mode] : "",
      seq,
      minSeq,
      complete: hasSnapshot && seq >= minSeq,
      cols: hasSnapshot ? this.lastSnapshotColsByMode[mode] : this.cols,
      rows: hasSnapshot ? this.lastSnapshotRowsByMode[mode] : this.rows,
      screenRevision: hasSnapshot
        ? this.lastSnapshotRevisionByMode[mode]
        : this.screenRevision,
      bufferType: hasSnapshot
        ? this.lastSnapshotBufferTypeByMode[mode]
        : this.screenBufferType,
    };
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
      this.disposeScreen();
      this.pid = null;
      this.runtimeId = null;
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
          useWindowsConsoleInput: this.useWindowsConsoleInputForRuntime,
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
    this.applyTerminalSize(size);
    if (this.state !== "running" || !this.pty) {
      return this.getStatus();
    }
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
    const { file, args, interactive } = shellForCommand(command);
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
        env: terminalEnvironment(),
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
    this.resetScreen(terminalSize);
    this.buffer = "";
    this.cols = terminalSize.cols;
    this.rows = terminalSize.rows;
    this.startedAt = startedAt;
    this.stoppedAt = null;
    this.lastOutputAt = null;
    this.exitCode = null;
    this.pid = terminal.pid;
    this.nextOutputSeq = 1;
    this.latestOutputSeq = 0;
    this.screenAppliedSeq = 0;
    this.inputQueue = Promise.resolve();
    this.exitPromise = exitPromise;
    this.stopPromise = null;
    this.useWindowsConsoleInputForRuntime = !interactive;

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
      this.latestOutputSeq = seq;
      this.queueScreenWrite(runtimeId, data, seq);
      this.options.onOutput({
        sessionId: this.options.sessionId,
        terminalId: this.options.terminalId,
        runtimeId,
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

  private applyTerminalSize(size: TerminalSize): void {
    const changed = this.cols !== size.cols || this.rows !== size.rows;
    this.cols = size.cols;
    this.rows = size.rows;

    if (changed && this.state === "running" && this.pty) {
      this.pty.resize(size.cols, size.rows);
    }

    if (changed) {
      this.queueScreenResize(this.runtimeId, size);
    }
  }

  private resetScreen(size: TerminalSize): void {
    this.disposeScreen();
    const screen = new HeadlessTerminal({
      allowProposedApi: true,
      cols: size.cols,
      convertEol: false,
      rows: size.rows,
      scrollback: terminalScrollbackRows,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer as unknown as HeadlessXterm.ITerminalAddon);
    this.screen = screen;
    this.serializer = serializer;
    this.clearPendingScreenWork();
    this.screenAppliedSeq = 0;
    this.screenRevision = 0;
    this.resetScreenMeasurement();
    this.resetSnapshotCache(this.runtimeId, size);
  }

  private disposeScreen(): void {
    this.serializer?.dispose();
    this.serializer = null;
    this.screen?.dispose();
    this.screen = null;
    this.clearPendingScreenWork();
    this.screenAppliedSeq = 0;
    this.screenRevision = 0;
    this.screenBufferType = "normal";
    this.screenBaseY = 0;
    this.screenRowFingerprints = [];
    this.resetSnapshotCache(null, { cols: this.cols, rows: this.rows });
  }

  private resetSnapshotCache(
    runtimeId: number | null,
    size: TerminalSize,
  ): void {
    this.lastSnapshotDataByMode = {
      tail: "",
      full: "",
    };
    this.lastSnapshotRuntimeIdByMode = {
      tail: runtimeId,
      full: runtimeId,
    };
    this.lastSnapshotSeqByMode = {
      tail: 0,
      full: 0,
    };
    this.lastSnapshotColsByMode = {
      tail: size.cols,
      full: size.cols,
    };
    this.lastSnapshotRowsByMode = {
      tail: size.rows,
      full: size.rows,
    };
    this.lastSnapshotRevisionByMode = { tail: 0, full: 0 };
    this.lastSnapshotBufferTypeByMode = {
      tail: "normal",
      full: "normal",
    };
    this.lastSnapshotValidByMode = { tail: false, full: false };
  }

  private fingerprintVisibleRows(): number[] {
    const screen = this.screen;
    if (!screen) {
      return [];
    }

    const buffer = screen.buffer.active;
    const fingerprints: number[] = [];
    const cell = buffer.getNullCell();
    const firstRow = buffer.baseY;
    for (let row = 0; row < this.rows; row += 1) {
      const line = buffer.getLine(firstRow + row);
      let hash = 2166136261;
      hash = Math.imul(hash ^ (line?.isWrapped ? 1 : 0), 16777619);
      for (let col = 0; col < this.cols; col += 1) {
        const current = line?.getCell(col, cell);
        if (!current) {
          hash = Math.imul(hash, 16777619);
          continue;
        }
        hash = Math.imul(hash ^ current.getCode(), 16777619);
        hash = Math.imul(hash ^ current.getWidth(), 16777619);
        hash = Math.imul(hash ^ current.getFgColorMode(), 16777619);
        hash = Math.imul(hash ^ current.getFgColor(), 16777619);
        hash = Math.imul(hash ^ current.getBgColorMode(), 16777619);
        hash = Math.imul(hash ^ current.getBgColor(), 16777619);
        const flags =
          current.isBold() |
          (current.isItalic() << 1) |
          (current.isDim() << 2) |
          (current.isUnderline() << 3) |
          (current.isBlink() << 4) |
          (current.isInverse() << 5) |
          (current.isInvisible() << 6) |
          (current.isStrikethrough() << 7) |
          (current.isOverline() << 8);
        hash = Math.imul(hash ^ flags, 16777619);
      }
      if (row === buffer.cursorY) {
        hash = Math.imul(hash ^ (buffer.cursorX + 1), 16777619);
      }
      fingerprints.push(hash >>> 0);
    }
    return fingerprints;
  }

  private resetScreenMeasurement(): void {
    const buffer = this.screen?.buffer.active;
    this.screenBufferType = buffer?.type ?? "normal";
    this.screenBaseY = buffer?.baseY ?? 0;
    this.screenRowFingerprints = this.fingerprintVisibleRows();
  }

  private measureScreenWork(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    const buffer = screen.buffer.active;
    const nextFingerprints = this.fingerprintVisibleRows();
    const scrolledRows =
      buffer.type === "normal" && this.screenBufferType === "normal"
        ? Math.max(0, buffer.baseY - this.screenBaseY)
        : 0;
    let changedRows = 0;
    for (let row = 0; row < nextFingerprints.length; row += 1) {
      if (nextFingerprints[row] !== this.screenRowFingerprints[row]) {
        changedRows += 1;
      }
    }

    this.screenRevision += scrolledRows > 0 ? scrolledRows : changedRows;
    this.screenBufferType = buffer.type;
    this.screenBaseY = buffer.baseY;
    this.screenRowFingerprints = nextFingerprints;
  }

  private publishScreenProgress(runtimeId: number, seq: number): void {
    this.options.onScreenProgress({
      sessionId: this.options.sessionId,
      terminalId: this.options.terminalId,
      runtimeId,
      seq,
      screenRevision: this.screenRevision,
      bufferType: this.screenBufferType,
      cols: this.cols,
      rows: this.rows,
    });
  }

  private clearPendingScreenWork(): void {
    this.screenFlushGeneration += 1;
    if (this.screenFlushImmediate !== null) {
      clearImmediate(this.screenFlushImmediate);
      this.screenFlushImmediate = null;
    }
    this.pendingScreenData = "";
    this.pendingScreenSeq = 0;
    this.pendingScreenResize = null;
    this.screenFlushInProgress = false;
    this.resolveScreenBoundaryWaiters();
  }

  private queueScreenResize(
    runtimeId: number | null,
    size: TerminalSize,
  ): void {
    if (runtimeId !== this.runtimeId || !this.screen) {
      return;
    }
    this.pendingScreenResize = size;
    this.scheduleScreenFlush();
  }

  private queueScreenWrite(runtimeId: number, data: string, seq: number): void {
    if (runtimeId !== this.runtimeId || !this.screen) {
      return;
    }
    this.pendingScreenData += data;
    this.pendingScreenSeq = Math.max(this.pendingScreenSeq, seq);
    this.scheduleScreenFlush();
  }

  private scheduleScreenFlush(): void {
    if (
      this.screenFlushImmediate !== null ||
      this.screenFlushInProgress ||
      (!this.pendingScreenResize && this.pendingScreenData.length === 0)
    ) {
      return;
    }
    this.screenFlushImmediate = setImmediate(() => {
      this.screenFlushImmediate = null;
      this.flushPendingScreen();
    });
  }

  private flushPendingScreen(): void {
    if (this.screenFlushInProgress) {
      return;
    }

    const screen = this.screen;
    const runtimeId = this.runtimeId;
    const resize = this.pendingScreenResize;
    const data = this.pendingScreenData;
    const seq = this.pendingScreenSeq;

    this.pendingScreenResize = null;
    this.pendingScreenData = "";
    this.pendingScreenSeq = 0;

    if (!screen || runtimeId === null || (!resize && !data)) {
      this.resolveScreenBoundaryWaiters();
      return;
    }

    if (resize) {
      try {
        screen.resize(resize.cols, resize.rows);
        this.resetScreenMeasurement();
      } catch (error) {
        console.warn(
          `[server] terminal screen resize failed for ${this.options.sessionId}/${this.options.terminalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!data) {
      this.resolveScreenBoundaryWaiters();
      return;
    }

    this.screenFlushInProgress = true;
    const flushGeneration = ++this.screenFlushGeneration;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finishWrite = (applied: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (flushGeneration !== this.screenFlushGeneration) {
        return;
      }
      if (applied && runtimeId === this.runtimeId && screen === this.screen) {
        this.screenAppliedSeq = Math.max(this.screenAppliedSeq, seq);
        this.measureScreenWork();
        this.publishScreenProgress(runtimeId, this.screenAppliedSeq);
      }
      this.screenFlushInProgress = false;
      this.resolveScreenBoundaryWaiters();
      this.scheduleScreenFlush();
    };
    timeout = setTimeout(() => {
      console.warn(
        `[server] terminal screen write timed out for ${this.options.sessionId}/${this.options.terminalId}`,
      );
      finishWrite(false);
    }, screenWriteCallbackTimeoutMs);

    try {
      screen.write(data, () => finishWrite(true));
    } catch (error) {
      console.warn(
        `[server] terminal screen write failed for ${this.options.sessionId}/${this.options.terminalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      finishWrite(false);
    }
  }

  private hasPendingScreenWork(): boolean {
    return (
      this.screenFlushImmediate !== null ||
      this.screenFlushInProgress ||
      this.pendingScreenResize !== null ||
      this.pendingScreenData.length > 0
    );
  }

  private waitForScreenBoundary(timeoutMs: number): Promise<void> {
    return new Promise((resolveWait) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timeout);
        this.screenBoundaryWaiters = this.screenBoundaryWaiters.filter(
          (waiter) => waiter !== finish,
        );
        resolveWait();
      };
      timeout = setTimeout(finish, timeoutMs);
      this.screenBoundaryWaiters.push(finish);
    });
  }

  private resolveScreenBoundaryWaiters(): void {
    const waiters = this.screenBoundaryWaiters;
    this.screenBoundaryWaiters = [];
    waiters.forEach((waiter) => waiter());
  }

  private async waitForSnapshotBoundary(
    runtimeId: number,
    minSeq: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.scheduleScreenFlush();
      if (
        runtimeId !== this.runtimeId ||
        !this.screen ||
        (!this.screenFlushInProgress &&
          this.pendingScreenResize === null &&
          this.screenAppliedSeq >= minSeq)
      ) {
        return;
      }

      const remainingMs = deadline - Date.now();
      const waitMs = Math.max(1, Math.min(25, remainingMs));
      await this.waitForScreenBoundary(waitMs);
    }
  }

  private captureSnapshotAtBoundary(
    runtimeId: number | null,
    mode: TerminalSnapshotMode,
  ): void {
    if (
      this.screenFlushInProgress ||
      this.pendingScreenResize !== null ||
      runtimeId !== this.runtimeId ||
      !this.screen ||
      !this.serializer
    ) {
      return;
    }

    try {
      this.lastSnapshotDataByMode[mode] =
        mode === "tail"
          ? this.serializer.serialize({ scrollback: 0 })
          : this.serializer.serialize();
      this.lastSnapshotRuntimeIdByMode[mode] = runtimeId;
      this.lastSnapshotSeqByMode[mode] = this.screenAppliedSeq;
      this.lastSnapshotColsByMode[mode] = this.cols;
      this.lastSnapshotRowsByMode[mode] = this.rows;
      this.lastSnapshotRevisionByMode[mode] = this.screenRevision;
      this.lastSnapshotBufferTypeByMode[mode] = this.screenBufferType;
      this.lastSnapshotValidByMode[mode] = true;
    } catch (error) {
      console.warn(
        `[server] terminal snapshot serialize failed for ${this.options.sessionId}/${this.options.terminalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
