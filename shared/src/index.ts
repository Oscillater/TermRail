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
  runtimeId: number | null;
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
  runtimeId: number;
  data: string;
  at: string;
  seq: number;
};

export type TerminalSnapshotFormat = "xterm-serialized-vt";
export type TerminalSnapshotMode = "tail" | "full";
export type TerminalBufferType = "normal" | "alternate";

export type TerminalScreenProgress = {
  sessionId: string;
  terminalId: string;
  runtimeId: number;
  seq: number;
  screenRevision: number;
  bufferType: TerminalBufferType;
  cols: number;
  rows: number;
};

export type WsClientMessage =
  | {
      type: "subscribe";
      sessionId: string;
      terminalId: string;
    }
  | {
      type: "snapshot";
      sessionId: string;
      terminalId: string;
      requestId: string;
      cols: number;
      rows: number;
      mode?: TerminalSnapshotMode;
      minSeq?: number;
    }
  | { type: "unsubscribe"; sessionId: string; terminalId: string }
  | { type: "input"; sessionId: string; terminalId: string; data: string }
  | {
      type: "resize";
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
    };

export type WsServerMessage =
  | {
      type: "subscribed";
      sessionId: string;
      terminalId: string;
      status: RuntimeStatus;
    }
  | {
      type: "terminal.snapshot";
      sessionId: string;
      terminalId: string;
      requestId: string;
      status: RuntimeStatus;
      runtimeId: number | null;
      format: TerminalSnapshotFormat;
      mode: TerminalSnapshotMode;
      data: string;
      seq: number;
      minSeq: number | null;
      complete: boolean;
      cols: number;
      rows: number;
      screenRevision: number;
      bufferType: TerminalBufferType;
    }
  | ({ type: "terminal.screen-progress" } & TerminalScreenProgress)
  | { type: "unsubscribed"; sessionId: string; terminalId: string }
  | {
      type: "terminal.output";
      sessionId: string;
      terminalId: string;
      runtimeId: number;
      data: string;
      at: string;
      seq: number;
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
