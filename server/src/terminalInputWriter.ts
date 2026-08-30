import { createHash } from "node:crypto";
import {
  isWindowsConsoleInputRetrySafe,
  shouldUseWindowsConsoleInput,
  WindowsConsoleInput,
} from "./windowsConsoleInput.js";

export type TerminalPtyInput = {
  write(data: string): void;
};

export type WindowsConsoleInputWriter = Pick<
  WindowsConsoleInput,
  "start" | "write" | "dispose"
>;

export type TerminalInputDelivery = "delivered" | "not-delivered" | "unknown";

export type TerminalInputWriteResult = {
  delivery: TerminalInputDelivery;
  method: "pty" | "windows-console-input";
  fallbackMethod?: "pty";
  error?: unknown;
};

type TerminalInputWriterOptions = {
  windowsConsoleInput: WindowsConsoleInputWriter | null;
  logConsoleInputSuccess: () => void;
  logConsoleInputFallback: (error: unknown) => void;
  logConsoleInputUnknown: (
    error: unknown,
    sessionId: string,
    terminalId: string,
  ) => void;
};

type TerminalInputWriteRequest = {
  terminal: TerminalPtyInput;
  processId: number | null;
  data: string;
  sessionId: string;
  terminalId: string;
  isCurrent: () => boolean;
};

function traceWindowsConsoleInput(
  sessionId: string,
  terminalId: string,
  data: string,
): void {
  if (process.env.TERMRAIL_TRACE_WINDOWS_INPUT !== "1") {
    return;
  }
  const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
  console.log(
    `[server] Windows console input helper delivered ${sessionId}/${terminalId} sha256=${sha256}`,
  );
}

export class TerminalInputWriter {
  constructor(private readonly options: TerminalInputWriterOptions) {}

  async write({
    terminal,
    processId,
    data,
    sessionId,
    terminalId,
    isCurrent,
  }: TerminalInputWriteRequest): Promise<TerminalInputWriteResult> {
    const windowsConsoleInput = this.options.windowsConsoleInput;
    if (
      !windowsConsoleInput ||
      processId === null ||
      !shouldUseWindowsConsoleInput(data)
    ) {
      terminal.write(data);
      return { delivery: "delivered", method: "pty" };
    }

    try {
      await windowsConsoleInput.write(processId, data);
      this.options.logConsoleInputSuccess();
      traceWindowsConsoleInput(sessionId, terminalId, data);
      return { delivery: "delivered", method: "windows-console-input" };
    } catch (error) {
      if (isWindowsConsoleInputRetrySafe(error)) {
        this.options.logConsoleInputFallback(error);
        if (isCurrent()) {
          terminal.write(data);
          return {
            delivery: "not-delivered",
            method: "windows-console-input",
            fallbackMethod: "pty",
            error,
          };
        }
        return {
          delivery: "not-delivered",
          method: "windows-console-input",
          error,
        };
      }

      this.options.logConsoleInputUnknown(error, sessionId, terminalId);
      return { delivery: "unknown", method: "windows-console-input", error };
    }
  }
}
