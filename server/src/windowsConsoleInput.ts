import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

type PendingRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type WindowsConsoleInputDelivery = "not-delivered" | "unknown";

export class WindowsConsoleInputError extends Error {
  constructor(
    message: string,
    readonly scope: "helper" | "target",
    readonly delivery: WindowsConsoleInputDelivery,
  ) {
    super(message);
    this.name = "WindowsConsoleInputError";
  }
}

export function isWindowsConsoleInputRetrySafe(
  error: unknown,
): error is WindowsConsoleInputError {
  return (
    error instanceof WindowsConsoleInputError &&
    error.delivery === "not-delivered"
  );
}

const helperPath = fileURLToPath(
  new URL("../scripts/windows-console-input.ps1", import.meta.url),
);
const defaultStartupTimeoutMs = 10_000;
const defaultRequestTimeoutMs = 5_000;
const csiKeyPattern = /^\x1b\[(?:(\d+)(?:;(\d+))?)?([ABCDHFZ~])$/;
const ss3KeyPattern = /^\x1bO[ABCDHFPQRS]$/;
const supportedTildeKeys = new Set([
  1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24,
]);

function spawnHelper(): ChildProcessWithoutNullStreams {
  return spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
}

export function shouldUseWindowsConsoleInput(data: string): boolean {
  if (!data.includes("\x1b")) {
    return [...data].every(
      (value) => value >= " " || "\b\t\n\r\x7f".includes(value),
    );
  }
  if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
    return true;
  }
  if (data === "\x1b" || ss3KeyPattern.test(data)) {
    return true;
  }
  if (
    data.length === 2 &&
    data[0] === "\x1b" &&
    data[1] >= " " &&
    data[1] !== "\x7f"
  ) {
    return true;
  }

  const csiKey = csiKeyPattern.exec(data);
  if (!csiKey) {
    return false;
  }
  if (csiKey[3] !== "~") {
    return true;
  }
  return supportedTildeKeys.has(Number(csiKey[1]));
}

export class WindowsConsoleInput {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private stderr = "";
  private disposed = false;
  private unavailableError: Error | null = null;

  constructor(
    private readonly createHelper: () => ChildProcessWithoutNullStreams = spawnHelper,
    private readonly timeouts: {
      startupTimeoutMs?: number;
      requestTimeoutMs?: number;
    } = {},
  ) {}

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new WindowsConsoleInputError(
          "Windows console input helper is closed",
          "helper",
          "not-delivered",
        ),
      );
    }
    if (this.unavailableError) {
      return Promise.reject(
        this.beforeDispatchError(this.unavailableError.message),
      );
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = this.createHelper();
      this.child = child;
      this.stderr = "";

      let ready = false;
      const startupTimeoutMs =
        this.timeouts.startupTimeoutMs ?? defaultStartupTimeoutMs;
      const timeout = setTimeout(() => {
        const error = new WindowsConsoleInputError(
          `Windows console input helper did not start within ${startupTimeoutMs}ms`,
          "helper",
          "not-delivered",
        );
        failStart(error);
        this.disable(error);
      }, startupTimeoutMs);

      const failStart = (error: Error) => {
        if (ready) {
          return;
        }
        ready = true;
        clearTimeout(timeout);
        reject(error);
      };

      this.lines = createInterface({ input: child.stdout });
      this.lines.on("line", (line) => {
        if (!ready) {
          if (line === "READY") {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
          return;
        }
        this.handleResponse(line);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
      });
      child.once("error", (error) => {
        const helperError = new WindowsConsoleInputError(
          error.message,
          "helper",
          "not-delivered",
        );
        failStart(helperError);
        this.handleExit(child, helperError);
      });
      child.once("exit", (code, signal) => {
        const details = this.stderr.trim();
        const error = new WindowsConsoleInputError(
          `Windows console input helper exited (${signal ?? code ?? "unknown"})${details ? `: ${details}` : ""}`,
          "helper",
          ready ? "unknown" : "not-delivered",
        );
        failStart(error);
        this.handleExit(child, error);
      });
    });

    return this.startPromise;
  }

  async write(processId: number, data: string): Promise<void> {
    await this.start();
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw this.beforeDispatchError(
        "Windows console input helper is unavailable",
      );
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const encoded = Buffer.from(data, "utf8").toString("base64");

    return new Promise<void>((resolve, reject) => {
      const requestTimeoutMs =
        this.timeouts.requestTimeoutMs ?? defaultRequestTimeoutMs;
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new WindowsConsoleInputError(
          `Windows console input request timed out after ${requestTimeoutMs}ms`,
          "helper",
          "unknown",
        );
        reject(error);
        this.disable(error);
      }, requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        child.stdin.write(
          `${requestId}\t${processId}\t${encoded}\n`,
          (error) => {
            if (!error) {
              return;
            }
            this.pending.delete(requestId);
            clearTimeout(timeout);
            const helperError = new WindowsConsoleInputError(
              error.message,
              "helper",
              "unknown",
            );
            reject(helperError);
            this.disable(helperError);
          },
        );
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timeout);
        const helperError = new WindowsConsoleInputError(
          error instanceof Error ? error.message : String(error),
          "helper",
          "unknown",
        );
        reject(helperError);
        this.disable(helperError);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    const error = new WindowsConsoleInputError(
      "Windows console input helper was closed",
      "helper",
      "unknown",
    );
    this.rejectPending(error);
    this.lines?.close();
    this.lines = null;
    this.child?.kill();
    this.child = null;
    this.startPromise = null;
  }

  private handleResponse(line: string): void {
    const [kind, requestIdValue, encodedMessage] = line.split("\t", 3);
    const requestId = Number(requestIdValue);
    const request = this.pending.get(requestId);
    if (!request) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(request.timeout);

    if (kind === "ACK") {
      request.resolve();
      return;
    }

    const message = encodedMessage
      ? Buffer.from(encodedMessage, "base64").toString("utf8")
      : "Windows console input helper rejected input";
    if (kind === "ERR_SAFE" || kind === "ERR_UNKNOWN") {
      request.reject(
        new WindowsConsoleInputError(
          message,
          "target",
          kind === "ERR_SAFE" ? "not-delivered" : "unknown",
        ),
      );
      return;
    }

    const error = new WindowsConsoleInputError(
      `Windows console input helper returned an invalid response: ${line}`,
      "helper",
      "unknown",
    );
    request.reject(error);
    this.disable(error);
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.child !== child) {
      return;
    }
    this.unavailableError = error;
    this.rejectPending(
      new WindowsConsoleInputError(error.message, "helper", "unknown"),
    );
    this.lines?.close();
    this.lines = null;
    this.child = null;
    this.startPromise = null;
  }

  private disable(error: Error): void {
    if (this.disposed || this.unavailableError) {
      return;
    }
    this.unavailableError = error;
    this.rejectPending(
      new WindowsConsoleInputError(error.message, "helper", "unknown"),
    );
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    child?.kill();
  }

  private beforeDispatchError(message: string): WindowsConsoleInputError {
    return new WindowsConsoleInputError(message, "helper", "not-delivered");
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
