export type PromptExample = {
  id: string;
  title: string;
  text: string;
};

export type SessionConfig = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  prompts: PromptExample[];
};

export type AppConfig = {
  prompts: PromptExample[];
  sessions: SessionConfig[];
};

export type RuntimeState = "running" | "stopped";

export type RuntimeStatus = {
  sessionId: string;
  state: RuntimeState;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  bufferLength: number;
};

export type TerminalOutputEvent = {
  sessionId: string;
  data: string;
  at: string;
};
