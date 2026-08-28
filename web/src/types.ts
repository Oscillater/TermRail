export type {
  AppConfig,
  PromptExample,
  RuntimeState,
  RuntimeStatus,
  SessionConfig,
  TerminalOutputEvent,
  TerminalSize,
  WsClientMessage,
  WsServerMessage,
} from "@termrail/shared";

import type { RuntimeStatus, TerminalOutputEvent } from "@termrail/shared";

export type SessionsResponse = {
  prompts?: import("@termrail/shared").PromptExample[];
  sessions: import("@termrail/shared").SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

export type SessionResponse = {
  session: import("@termrail/shared").SessionConfig;
};

export type PromptsResponse = {
  prompts: import("@termrail/shared").PromptExample[];
};

export type StatusResponse = {
  status: RuntimeStatus;
};

export type StatusesResponse = {
  statuses: Record<string, RuntimeStatus>;
};

export type TerminalInputRequest = {
  id: number;
  data: string;
};

export type TerminalScrollState = {
  viewportY: number;
  baseY: number;
};

export type TerminalOutputDelivery = TerminalOutputEvent & {
  deliveryId: number;
};

export type TerminalSessionSnapshot = {
  id: number;
  sessionId: string;
  status: RuntimeStatus;
  buffer: string;
};

export type StreamConnectionState =
  "idle" | "connecting" | "connected" | "closed";

export type OutputActivityState = "running" | "working" | "quiet" | "stopped";

export type OutputActivity = {
  state: OutputActivityState;
  updatedAt: number;
};

export type OutputActivities = Record<string, OutputActivity>;

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
