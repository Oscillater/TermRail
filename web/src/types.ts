export type {
  AppConfig,
  PromptExample,
  RuntimeState,
  RuntimeStatus,
  SessionConfig,
  TerminalConfig,
  TerminalBufferType,
  TerminalOutputEvent,
  TerminalScreenProgress,
  TerminalSnapshotMode,
  TerminalSize,
  WsClientMessage,
  WsServerMessage,
} from "@termrail/shared";

import type { RuntimeStatus, TerminalSnapshotMode } from "@termrail/shared";

export type SessionsResponse = {
  prompts?: import("@termrail/shared").PromptExample[];
  sessions: import("@termrail/shared").SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
  terminalStatuses?: Record<string, Record<string, RuntimeStatus>>;
};

export type SessionResponse = {
  session: import("@termrail/shared").SessionConfig;
};

export type PromptsResponse = {
  prompts: import("@termrail/shared").PromptExample[];
};

export type StatusResponse = {
  status: RuntimeStatus;
  sessionStatus?: RuntimeStatus;
  terminalStatuses?: Record<string, RuntimeStatus>;
  terminalStatus?: RuntimeStatus;
};

export type StatusesResponse = {
  statuses: Record<string, RuntimeStatus>;
  terminalStatuses?: Record<string, Record<string, RuntimeStatus>>;
};

export type TerminalsResponse = {
  terminals: import("@termrail/shared").TerminalConfig[];
  statuses: Record<string, RuntimeStatus>;
};

export type TerminalResponse = {
  session: import("@termrail/shared").SessionConfig;
  terminal: import("@termrail/shared").TerminalConfig;
  status?: RuntimeStatus;
  sessionStatus?: RuntimeStatus;
};

export type TerminalInputRequest = {
  id: number;
  data: string;
};

export type TerminalFocusRequest = TerminalTarget & {
  id: number;
};

export type TerminalScrollState = {
  viewportY: number;
  baseY: number;
};

export type TerminalTarget = {
  sessionId: string;
  terminalId: string;
};

export type TerminalSnapshotRequestOptions = {
  mode?: TerminalSnapshotMode;
  minSeq?: number;
};

export type StreamConnectionState =
  "idle" | "connecting" | "connected" | "closed";

export type OutputActivityState = "running" | "working" | "quiet" | "stopped";

export type OutputActivity = {
  state: OutputActivityState;
  updatedAt: number;
};

export type OutputActivities = Record<string, OutputActivity>;

export type TerminalAttentionState =
  "idle" | "running" | "working" | "ready" | "done" | "stopped";

export type TerminalAttention = {
  state: TerminalAttentionState;
  unread: boolean;
  updatedAt: number;
};

export type TerminalAttentionBySession = Record<
  string,
  Record<string, TerminalAttention>
>;

export type SessionAttention = {
  terminalCount: number;
  unreadCount: number;
  unreadReadyCount: number;
  unreadDoneCount: number;
  readyCount: number;
  workingCount: number;
  runningCount: number;
  stoppedCount: number;
  updatedAt: number;
};

export type SessionAttentionById = Record<string, SessionAttention>;

export type DirectoryEntry = {
  name: string;
  path: string;
};

export type DirectoryRootsResponse = {
  roots: DirectoryEntry[];
};

export type DirectoryListing = {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
};
