export type PromptExample = {
  id: string;
  title: string;
  text: string;
};

export type TerminalConfig = {
  id: string;
  name: string;
  command: string;
};

export type SessionConfig = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  terminals: TerminalConfig[];
  prompts: PromptExample[];
};

export type AppConfig = {
  prompts: PromptExample[];
  sessions: SessionConfig[];
};

export type RuntimeState = "running" | "stopped";

export type RuntimeStatus = {
  sessionId: string;
  terminalId?: string;
  state: RuntimeState;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  bufferLength: number;
};

export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TerminalOutputEvent = {
  sessionId: string;
  terminalId: string;
  data: string;
  at: string;
  seq: number;
};

export type WsClientMessage =
  | {
      type: "subscribe";
      sessionId: string;
      terminalId?: string;
      includeBuffer?: boolean;
    }
  | { type: "unsubscribe"; sessionId: string; terminalId?: string }
  | { type: "input"; sessionId: string; terminalId?: string; data: string }
  | {
      type: "resize";
      sessionId: string;
      terminalId?: string;
      cols: number;
      rows: number;
    };

export type WsServerMessage =
  | {
      type: "subscribed";
      sessionId: string;
      terminalId: string;
      status: RuntimeStatus;
      buffer: string;
    }
  | { type: "unsubscribed"; sessionId: string; terminalId: string }
  | {
      type: "terminal.output";
      sessionId: string;
      terminalId: string;
      data: string;
      at?: string;
      seq?: number;
    }
  | {
      type: "terminal.status";
      sessionId: string;
      terminalId: string;
      status: RuntimeStatus;
    }
  | { type: "session.status"; sessionId: string; status: RuntimeStatus }
  | {
      type: "error";
      error: { code: string; message: string; details?: unknown };
    };

export const defaultTerminalId = "main";

export const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const terminalSizeLimits = {
  minCols: 10,
  maxCols: 500,
  minRows: 3,
  maxRows: 200,
} as const;

export function isValidId(value: string): boolean {
  return idPattern.test(value);
}
