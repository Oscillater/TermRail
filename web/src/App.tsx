import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type PromptExample = {
  id: string;
  title: string;
  text: string;
};

type SessionConfig = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  prompts: PromptExample[];
};

type RuntimeState = "running" | "stopped";

type RuntimeStatus = {
  sessionId: string;
  state: RuntimeState;
  startedAt: string | null;
  stoppedAt: string | null;
  lastOutputAt: string | null;
  exitCode: number | null;
  pid: number | null;
  bufferLength: number;
};

type SessionsResponse = {
  prompts?: PromptExample[];
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

type SessionResponse = {
  session: SessionConfig;
};

type PromptsResponse = {
  prompts: PromptExample[];
};

type StatusResponse = {
  status: RuntimeStatus;
};

type StatusesResponse = {
  statuses: Record<string, RuntimeStatus>;
};

type TerminalInputRequest = {
  id: number;
  data: string;
};

type TerminalSize = {
  cols: number;
  rows: number;
};

type TerminalScrollState = {
  viewportY: number;
  baseY: number;
};

type OutputActivityState = "running" | "working" | "quiet" | "stopped";

type OutputActivity = {
  state: OutputActivityState;
  updatedAt: number;
};

type OutputActivities = Record<string, OutputActivity>;

type DirectoryEntry = {
  name: string;
  path: string;
};

type DirectoryRootsResponse = {
  roots: DirectoryEntry[];
};

type DirectoryListing = {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
};

type WsMessage =
  | {
      type: "subscribed";
      sessionId: string;
      status: RuntimeStatus;
      buffer: string;
    }
  | { type: "unsubscribed"; sessionId: string }
  | { type: "terminal.output"; sessionId: string; data: string; at?: string }
  | { type: "session.status"; sessionId: string; status: RuntimeStatus }
  | {
      type: "error";
      error: { code: string; message: string; details?: unknown };
    };

const authToken = (import.meta.env.VITE_AUTH_TOKEN ?? "").trim();
const terminalSizeLimits = {
  minCols: 10,
  maxCols: 500,
  minRows: 3,
  maxRows: 200,
};
const outputQuietDelayMs = 3_000;
const statusRefreshIntervalMs = 2_000;

function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function defaultRuntimeStatus(sessionId: string): RuntimeStatus {
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

function collectSessionPrompts(sessions: SessionConfig[]): PromptExample[] {
  const prompts: PromptExample[] = [];
  const seen = new Set<string>();

  sessions.forEach((session) => {
    session.prompts.forEach((prompt) => {
      if (seen.has(prompt.id)) {
        return;
      }
      seen.add(prompt.id);
      prompts.push({ ...prompt });
    });
  });

  return prompts;
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampTerminalSize(cols: number, rows: number) {
  return {
    cols: clampValue(
      cols,
      terminalSizeLimits.minCols,
      terminalSizeLimits.maxCols,
    ),
    rows: clampValue(
      rows,
      terminalSizeLimits.minRows,
      terminalSizeLimits.maxRows,
    ),
  };
}

function readTerminalScrollState(
  terminal: Terminal | null,
): TerminalScrollState {
  if (!terminal) {
    return { viewportY: 0, baseY: 0 };
  }

  const buffer = terminal.buffer.active;
  const baseY = Math.max(0, buffer.baseY);
  return {
    baseY,
    viewportY: clampValue(buffer.viewportY, 0, baseY),
  };
}

function apiHeaders(): HeadersInit {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function jsonHeaders(): HeadersInit {
  return {
    ...apiHeaders(),
    "Content-Type": "application/json",
  };
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  textArea.style.left = "-1000px";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) {
    throw new Error("Clipboard copy was blocked by the browser");
  }
}

async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText && window.isSecureContext) {
    return await navigator.clipboard.readText();
  }

  throw new Error("Clipboard paste was blocked by the browser");
}

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  if (authToken) {
    url.searchParams.set("token", authToken);
  }
  return url.toString();
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...apiHeaders(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      message = body.error?.message ?? body.error?.code ?? message;
    } catch {
      // Keep the HTTP status fallback when the server did not return JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function timestampFromIso(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestIso(left: string | null, right: string | null): string | null {
  const leftTimestamp = timestampFromIso(left);
  const rightTimestamp = timestampFromIso(right);

  if (leftTimestamp === null) {
    return right;
  }
  if (rightTimestamp === null) {
    return left;
  }

  return leftTimestamp > rightTimestamp ? left : right;
}

function mergeRuntimeStatus(
  current: RuntimeStatus | undefined,
  incoming: RuntimeStatus,
): RuntimeStatus {
  if (!current || current.startedAt !== incoming.startedAt) {
    return incoming;
  }

  const merged = {
    ...incoming,
    lastOutputAt: latestIso(current.lastOutputAt, incoming.lastOutputAt),
  };

  const currentStoppedAt = timestampFromIso(current.stoppedAt);
  const incomingLastOutputAt = timestampFromIso(incoming.lastOutputAt);
  if (
    current.state === "stopped" &&
    incoming.state === "running" &&
    currentStoppedAt !== null &&
    (incomingLastOutputAt === null || currentStoppedAt >= incomingLastOutputAt)
  ) {
    return {
      ...merged,
      state: "stopped",
      stoppedAt: current.stoppedAt,
      exitCode: current.exitCode,
      pid: null,
    };
  }

  return merged;
}

function activityFromStatus(
  status: RuntimeStatus | undefined,
  acknowledgedAt: number,
  now: number,
): OutputActivity | undefined {
  if (!status) {
    return undefined;
  }

  if (status.state === "stopped") {
    const stoppedAt = timestampFromIso(status.stoppedAt);
    if (stoppedAt !== null && stoppedAt > acknowledgedAt) {
      return { state: "stopped", updatedAt: stoppedAt };
    }
    return undefined;
  }

  const lastOutputAt = timestampFromIso(status.lastOutputAt);
  if (lastOutputAt === null || lastOutputAt <= acknowledgedAt) {
    return undefined;
  }

  return {
    state: now - lastOutputAt >= outputQuietDelayMs ? "quiet" : "working",
    updatedAt: lastOutputAt,
  };
}

function statusLabel(status: RuntimeStatus | undefined): string {
  return status?.state === "running" ? "Running" : "Stopped";
}

function outputActivityLabel(state: OutputActivityState): string {
  switch (state) {
    case "running":
      return "Running";
    case "working":
      return "Working";
    case "quiet":
      return "Quiet";
    case "stopped":
      return "Stopped";
  }
}

function outputActivityDetail(activity: OutputActivity): string {
  switch (activity.state) {
    case "running":
      return "Process running";
    case "working":
      return "Output is streaming";
    case "quiet":
      return "Output paused";
    case "stopped":
      return "Process stopped";
  }
}

function activitySortValue(state: OutputActivityState): number {
  switch (state) {
    case "quiet":
      return 0;
    case "stopped":
      return 1;
    case "working":
      return 2;
    case "running":
      return 3;
  }
}

function AppShell() {
  const [prompts, setPrompts] = useState<PromptExample[]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [activityAcknowledgedAt, setActivityAcknowledgedAt] = useState<
    Record<string, number>
  >({});
  const [activityNow, setActivityNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalInputRequest, setTerminalInputRequest] =
    useState<TerminalInputRequest | null>(null);
  const [terminalSize, setTerminalSize] = useState<TerminalSize | null>(null);
  const sessionsRef = useRef<SessionConfig[]>([]);
  const statusesRef = useRef<Record<string, RuntimeStatus>>({});
  const statusRefreshInFlightRef = useRef(false);
  const terminalInputRequestIdRef = useRef(0);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedStatus = selectedSessionId
    ? statuses[selectedSessionId]
    : undefined;

  const subscribedSessionIdsKey = useMemo(
    () => JSON.stringify(sessions.map((session) => session.id)),
    [sessions],
  );

  const outputActivities = useMemo(() => {
    const next: OutputActivities = {};
    sessions.forEach((session) => {
      const activity = activityFromStatus(
        statuses[session.id],
        activityAcknowledgedAt[session.id] ?? 0,
        activityNow,
      );
      if (activity) {
        next[session.id] = activity;
      }
    });
    return next;
  }, [activityAcknowledgedAt, activityNow, sessions, statuses]);

  const updateStatus = useCallback((status: RuntimeStatus) => {
    setStatuses((current) => {
      const mergedStatus = mergeRuntimeStatus(
        current[status.sessionId],
        status,
      );
      statusesRef.current = {
        ...statusesRef.current,
        [status.sessionId]: mergedStatus,
      };
      return { ...current, [status.sessionId]: mergedStatus };
    });
  }, []);

  const acknowledgeActivity = useCallback((sessionId: string) => {
    const acknowledgedAt = Date.now();
    setActivityAcknowledgedAt((current) => ({
      ...current,
      [sessionId]: acknowledgedAt,
    }));
    setActivityNow(acknowledgedAt);
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      acknowledgeActivity(sessionId);
    },
    [acknowledgeActivity],
  );

  const upsertSession = useCallback((session: SessionConfig) => {
    setSessions((current) => {
      const existingIndex = current.findIndex((item) => item.id === session.id);
      if (existingIndex === -1) {
        return [...current, session];
      }

      return current.map((item) => (item.id === session.id ? session : item));
    });
    statusesRef.current = {
      ...statusesRef.current,
      [session.id]:
        statusesRef.current[session.id] ?? defaultRuntimeStatus(session.id),
    };
    setStatuses((current) => ({
      ...current,
      [session.id]: current[session.id] ?? defaultRuntimeStatus(session.id),
    }));
  }, []);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<SessionsResponse>("/api/sessions");
      setPrompts(data.prompts ?? collectSessionPrompts(data.sessions));
      setPromptsLoaded(true);
      setSessions(data.sessions);
      statusesRef.current = data.statuses;
      setStatuses(data.statuses);
      setActivityNow(Date.now());
      setSelectedSessionId((current) => {
        if (
          current &&
          data.sessions.some((session) => session.id === current)
        ) {
          return current;
        }
        return data.sessions[0]?.id ?? null;
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Failed to load sessions",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (selectedSessionId) {
      acknowledgeActivity(selectedSessionId);
    }
  }, [acknowledgeActivity, selectedSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
    const sessionIds = new Set(sessions.map((session) => session.id));
    setActivityAcknowledgedAt((current) => {
      let changed = false;
      const next: Record<string, number> = {};
      Object.entries(current).forEach(([sessionId, acknowledgedAt]) => {
        if (sessionIds.has(sessionId)) {
          next[sessionId] = acknowledgedAt;
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    const updateActivityNow = () => setActivityNow(Date.now());
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        updateActivityNow();
      }
    };
    const timerId = window.setInterval(updateActivityNow, 1_000);

    window.addEventListener("focus", updateActivityNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timerId);
      window.removeEventListener("focus", updateActivityNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const handleActivityOutput = useCallback(
    (sessionId: string, outputAtIso?: string) => {
      if (!sessionsRef.current.some((session) => session.id === sessionId)) {
        return;
      }

      const receivedAt = Date.now();
      const outputAt = timestampFromIso(outputAtIso ?? null) ?? receivedAt;
      const previousStatus =
        statusesRef.current[sessionId] ?? defaultRuntimeStatus(sessionId);

      updateStatus({
        ...previousStatus,
        sessionId,
        state: "running",
        stoppedAt: null,
        exitCode: null,
        lastOutputAt: new Date(outputAt).toISOString(),
      });
      setActivityNow(receivedAt);
    },
    [updateStatus],
  );

  const handleSessionStatus = useCallback(
    (status: RuntimeStatus) => {
      updateStatus(status);
      setActivityNow(Date.now());
    },
    [updateStatus],
  );

  const refreshStatuses = useCallback(async () => {
    if (statusRefreshInFlightRef.current || sessionsRef.current.length === 0) {
      return;
    }

    statusRefreshInFlightRef.current = true;
    try {
      const data = await apiRequest<StatusesResponse>("/api/status");
      Object.values(data.statuses).forEach(handleSessionStatus);
      setActivityNow(Date.now());
    } catch {
      // The WebSocket is still the primary live channel; polling is best-effort.
    } finally {
      statusRefreshInFlightRef.current = false;
    }
  }, [handleSessionStatus]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      void refreshStatuses();
    }, statusRefreshIntervalMs);

    const refreshWhenVisible = () => {
      if (!document.hidden) {
        void refreshStatuses();
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(timerId);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshStatuses]);

  useEffect(() => {
    const sessionIds = JSON.parse(subscribedSessionIdsKey) as string[];
    if (sessionIds.length === 0) {
      return undefined;
    }

    let closed = false;
    let reconnectTimerId: number | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      const nextSocket = new WebSocket(wsUrl());
      socket = nextSocket;

      nextSocket.addEventListener("open", () => {
        if (closed || socket !== nextSocket) {
          return;
        }
        sessionIds.forEach((sessionId) => {
          nextSocket.send(
            JSON.stringify({
              type: "subscribe",
              sessionId,
              includeBuffer: false,
            }),
          );
        });
      });

      nextSocket.addEventListener("message", (event) => {
        if (closed || socket !== nextSocket) {
          return;
        }

        let message: WsMessage;
        try {
          message = JSON.parse(String(event.data)) as WsMessage;
        } catch {
          return;
        }

        switch (message.type) {
          case "subscribed":
            handleSessionStatus(message.status);
            break;
          case "terminal.output":
            handleActivityOutput(message.sessionId, message.at);
            break;
          case "session.status":
            handleSessionStatus(message.status);
            break;
          case "error":
          case "unsubscribed":
            break;
        }
      });

      nextSocket.addEventListener("close", () => {
        if (closed || socket !== nextSocket) {
          return;
        }
        reconnectTimerId = window.setTimeout(connect, 1_000);
      });

      nextSocket.addEventListener("error", () => {
        nextSocket.close();
      });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId);
      }
      if (socket?.readyState === WebSocket.OPEN) {
        sessionIds.forEach((sessionId) => {
          socket?.send(JSON.stringify({ type: "unsubscribe", sessionId }));
        });
      }
      socket?.close();
    };
  }, [handleActivityOutput, handleSessionStatus, subscribedSessionIdsKey]);

  const runAction = useCallback(
    async (sessionId: string, action: "start" | "stop") => {
      setActionSessionId(sessionId);
      setError(null);
      try {
        const startOptions =
          action === "start" && terminalSize
            ? {
                headers: jsonHeaders(),
                body: JSON.stringify(terminalSize),
              }
            : {};
        const data = await apiRequest<StatusResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
          { method: "POST", ...startOptions },
        );
        handleSessionStatus(data.status);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : `Failed to ${action} session`,
        );
      } finally {
        setActionSessionId(null);
      }
    },
    [handleSessionStatus, terminalSize],
  );

  const createSession = useCallback(
    async (session: SessionConfig) => {
      setError(null);
      const data = await apiRequest<SessionResponse>("/api/sessions", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(session),
      });
      upsertSession(data.session);
      selectSession(data.session.id);
      return data.session;
    },
    [selectSession, upsertSession],
  );

  const updateSession = useCallback(
    async (sessionId: string, session: SessionConfig) => {
      setError(null);
      const data = await apiRequest<SessionResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify(session),
        },
      );
      upsertSession(data.session);
      selectSession(data.session.id);
      return data.session;
    },
    [selectSession, upsertSession],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      setError(null);
      await apiRequest<SessionResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );

      const nextSessions = sessions.filter(
        (session) => session.id !== sessionId,
      );
      setSessions(nextSessions);
      setSelectedSessionId((selected) =>
        selected === sessionId ? (nextSessions[0]?.id ?? null) : selected,
      );
      setStatuses((current) => {
        const next = { ...current };
        delete next[sessionId];
        delete statusesRef.current[sessionId];
        return next;
      });
      setActivityAcknowledgedAt((current) => {
        if (current[sessionId] === undefined) {
          return current;
        }
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    },
    [sessions],
  );

  const updatePrompts = useCallback(async (nextPrompts: PromptExample[]) => {
    setError(null);
    const data = await apiRequest<PromptsResponse>("/api/prompts", {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ prompts: nextPrompts }),
    });
    setPrompts(data.prompts);
    return data.prompts;
  }, []);

  const requestTerminalInput = useCallback((data: string) => {
    terminalInputRequestIdRef.current += 1;
    setTerminalInputRequest({
      id: terminalInputRequestIdRef.current,
      data,
    });
  }, []);

  return (
    <main className="app-shell">
      <SessionList
        actionSessionId={actionSessionId}
        loading={loading}
        onCreateSession={createSession}
        onDeleteSession={deleteSession}
        onEditSession={updateSession}
        onRefresh={loadSessions}
        onSelect={selectSession}
        onStart={(sessionId) => void runAction(sessionId, "start")}
        onStop={(sessionId) => void runAction(sessionId, "stop")}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
        outputActivities={outputActivities}
        statuses={statuses}
      />
      <TerminalPane
        error={error}
        inputRequest={terminalInputRequest}
        onError={setError}
        onOutput={handleActivityOutput}
        onSize={setTerminalSize}
        onStatus={handleSessionStatus}
        session={selectedSession}
        status={selectedStatus}
      />
      <PromptExamples
        onTerminalInput={requestTerminalInput}
        onUpdatePrompts={updatePrompts}
        prompts={prompts}
        promptsLoaded={promptsLoaded}
        session={selectedSession}
        status={selectedStatus}
      />
    </main>
  );
}

type SessionListProps = {
  actionSessionId: string | null;
  loading: boolean;
  onCreateSession: (session: SessionConfig) => Promise<SessionConfig>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onEditSession: (
    sessionId: string,
    session: SessionConfig,
  ) => Promise<SessionConfig>;
  onRefresh: () => void;
  onSelect: (sessionId: string) => void;
  onStart: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  outputActivities: OutputActivities;
  selectedSessionId: string | null;
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

type SessionDraft = {
  id: string;
  name: string;
  cwd: string;
  command: string;
};

type SessionEditorState = {
  mode: "create" | "edit";
  originalId: string | null;
};

function newSessionDraft(): SessionDraft {
  return {
    id: makeLocalId("session"),
    name: "",
    cwd: ".",
    command: "",
  };
}

function draftFromSession(session: SessionConfig): SessionDraft {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    command: session.command,
  };
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type DirectoryPickerProps = {
  disabled: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  value: string;
};

function DirectoryPicker({
  disabled,
  onClose,
  onSelect,
  value,
}: DirectoryPickerProps) {
  const [roots, setRoots] = useState<DirectoryEntry[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoots = useCallback(async () => {
    try {
      const data = await apiRequest<DirectoryRootsResponse>(
        "/api/filesystem/roots",
      );
      setRoots(data.roots);
    } catch (requestError) {
      setError(messageFromError(requestError, "Failed to load folders"));
    }
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DirectoryListing>(
        `/api/filesystem/directories?path=${encodeURIComponent(path)}`,
      );
      setListing(data);
    } catch (requestError) {
      setError(messageFromError(requestError, "Failed to load folders"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
    void loadDirectory(value || ".");
  }, [loadDirectory, loadRoots, value]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, onClose]);

  return (
    <div
      className="directory-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !disabled) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby="directory-picker-title"
        aria-modal="true"
        className="directory-picker"
        role="dialog"
      >
        <div className="directory-picker-header">
          <div>
            <span className="field-label">Folder</span>
            <h2 id="directory-picker-title">Choose CWD</h2>
            <p>{listing?.path ?? value}</p>
          </div>
          <button
            className="ghost-button compact"
            disabled={disabled}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        <div className="directory-roots">
          {roots.map((root) => (
            <button
              disabled={disabled || loading}
              key={root.path}
              onClick={() => void loadDirectory(root.path)}
              type="button"
            >
              {root.name}
            </button>
          ))}
        </div>

        <div className="directory-list">
          {listing?.parentPath ? (
            <button
              disabled={disabled || loading}
              onClick={() => void loadDirectory(listing.parentPath ?? ".")}
              type="button"
            >
              ..
            </button>
          ) : null}
          {loading ? (
            <p className="directory-empty">Loading folders...</p>
          ) : null}
          {!loading && listing && listing.entries.length === 0 ? (
            <p className="directory-empty">No subfolders.</p>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              disabled={disabled || loading}
              key={entry.path}
              onClick={() => void loadDirectory(entry.path)}
              type="button"
            >
              {entry.name}
            </button>
          ))}
        </div>

        <div className="form-actions">
          <button
            className="primary-button"
            disabled={disabled || !listing}
            onClick={() => {
              if (listing) {
                onSelect(listing.path);
                onClose();
              }
            }}
            type="button"
          >
            Use Folder
          </button>
          <button
            className="ghost-button"
            disabled={disabled}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionList({
  actionSessionId,
  loading,
  onCreateSession,
  onDeleteSession,
  onEditSession,
  onRefresh,
  onSelect,
  onStart,
  onStop,
  outputActivities,
  selectedSessionId,
  sessions,
  statuses,
}: SessionListProps) {
  const [editor, setEditor] = useState<SessionEditorState | null>(null);
  const [draft, setDraft] = useState<SessionDraft>(() => newSessionDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const visibleActivityItems = sessions
    .map((session, index) => {
      const outputActivity = outputActivities[session.id];
      const status = statuses[session.id];
      const activity =
        outputActivity ??
        (status?.state === "running"
          ? {
              state: "running" as const,
              updatedAt: 0,
            }
          : undefined);

      return { activity, index, session };
    })
    .filter(
      (
        item,
      ): item is {
        activity: OutputActivity;
        index: number;
        session: SessionConfig;
      } => Boolean(item.activity),
    );
  const quietActivityCount = visibleActivityItems.filter(
    (item) =>
      item.activity.state === "quiet" || item.activity.state === "stopped",
  ).length;
  const activeActivityCount = visibleActivityItems.filter(
    (item) =>
      item.activity.state === "working" || item.activity.state === "running",
  ).length;
  const activitySummary =
    quietActivityCount > 0
      ? `${quietActivityCount} ready`
      : activeActivityCount > 0
        ? `${activeActivityCount} active`
        : "Idle";
  const sortedActivityItems = [...visibleActivityItems].sort(
    (left, right) =>
      activitySortValue(left.activity.state) -
        activitySortValue(right.activity.state) || left.index - right.index,
  );

  const openCreateEditor = () => {
    setEditor({ mode: "create", originalId: null });
    setDraft(newSessionDraft());
    setFormError(null);
    setDirectoryPickerOpen(false);
  };

  const openEditEditor = (session: SessionConfig) => {
    onSelect(session.id);
    setEditor({ mode: "edit", originalId: session.id });
    setDraft(draftFromSession(session));
    setFormError(null);
    setDirectoryPickerOpen(false);
  };

  const updateDraft = (field: keyof SessionDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const handleSessionSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) {
      return;
    }

    setFormError(null);

    const existingSession =
      editor.mode === "edit"
        ? sessions.find((session) => session.id === editor.originalId)
        : null;

    const session: SessionConfig = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      cwd: draft.cwd.trim(),
      command: draft.command.trim(),
      prompts: existingSession?.prompts ?? [],
    };

    if (!session.id || !session.name || !session.cwd || !session.command) {
      setFormError("id, name, cwd, and command are required");
      return;
    }

    setSaving(true);
    try {
      if (editor.mode === "create") {
        await onCreateSession(session);
      } else {
        await onEditSession(editor.originalId ?? session.id, session);
      }
      setEditor(null);
      setDirectoryPickerOpen(false);
    } catch (error) {
      setFormError(messageFromError(error, "Failed to save session"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSession = async (session: SessionConfig) => {
    const confirmed = window.confirm(
      `Delete session "${session.name}"? Running processes will be stopped.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingSessionId(session.id);
    setFormError(null);
    try {
      await onDeleteSession(session.id);
      if (editor?.originalId === session.id) {
        setEditor(null);
        setDirectoryPickerOpen(false);
      }
    } catch (error) {
      setFormError(messageFromError(error, "Failed to delete session"));
    } finally {
      setDeletingSessionId(null);
    }
  };

  return (
    <aside className="session-panel" aria-label="Sessions">
      <div className="panel-header">
        <div>
          <p className="eyebrow">TermRail</p>
          <h1>Sessions</h1>
        </div>
        <div className="panel-header-actions">
          <button
            className="ghost-button"
            disabled={loading}
            onClick={onRefresh}
            type="button"
          >
            Refresh
          </button>
          <button
            className="primary-button"
            onClick={openCreateEditor}
            type="button"
          >
            Add
          </button>
        </div>
      </div>

      <div className="activity-box" aria-live="polite">
        <div className="activity-header">
          <span className="activity-title">Activity</span>
          <span className="activity-count">{activitySummary}</span>
        </div>
        {sortedActivityItems.length > 0 ? (
          <div className="activity-list">
            {sortedActivityItems.map(({ activity, session }) => (
              <button
                className={`activity-item ${activity.state}`}
                key={session.id}
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className="activity-item-main">
                  <span className="activity-item-name">{session.name}</span>
                  <span className="activity-item-detail">
                    {outputActivityDetail(activity)}
                  </span>
                </span>
                <span className={`activity-state ${activity.state}`}>
                  {outputActivityLabel(activity.state)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="activity-empty">No paused output.</p>
        )}
      </div>

      {editor ? (
        <form className="side-form" onSubmit={handleSessionSubmit}>
          <div className="form-title-row">
            <h2>{editor.mode === "create" ? "Add Session" : "Edit Session"}</h2>
            <button
              className="ghost-button compact"
              disabled={saving}
              onClick={() => {
                setEditor(null);
                setDirectoryPickerOpen(false);
              }}
              type="button"
            >
              Close
            </button>
          </div>
          {formError ? <div className="form-error">{formError}</div> : null}
          <label>
            <span>ID</span>
            <input
              disabled={saving || editor.mode === "edit"}
              onChange={(event) => updateDraft("id", event.target.value)}
              required
              value={draft.id}
            />
          </label>
          <label>
            <span>Name</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("name", event.target.value)}
              required
              value={draft.name}
            />
          </label>
          <div className="form-field">
            <span className="field-label">CWD</span>
            <div className="input-row">
              <input
                disabled={saving}
                onChange={(event) => updateDraft("cwd", event.target.value)}
                required
                value={draft.cwd}
              />
              <button
                className="ghost-button"
                disabled={saving}
                onClick={() => setDirectoryPickerOpen(true)}
                type="button"
              >
                Browse
              </button>
            </div>
          </div>
          {directoryPickerOpen ? (
            <DirectoryPicker
              disabled={saving}
              onClose={() => setDirectoryPickerOpen(false)}
              onSelect={(path) => updateDraft("cwd", path)}
              value={draft.cwd}
            />
          ) : null}
          <label>
            <span>Command</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("command", event.target.value)}
              required
              value={draft.command}
            />
          </label>
          <div className="form-actions">
            <button className="primary-button" disabled={saving} type="submit">
              {saving ? "Saving" : "Save"}
            </button>
            <button
              className="ghost-button"
              disabled={saving}
              onClick={() => {
                setEditor(null);
                setDirectoryPickerOpen(false);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {formError && !editor ? (
        <div className="form-error">{formError}</div>
      ) : null}

      <div className="session-list">
        {loading ? <p className="empty-state">Loading sessions...</p> : null}
        {!loading && sessions.length === 0 ? (
          <p className="empty-state">No configured sessions.</p>
        ) : null}
        {sessions.map((session) => {
          const status = statuses[session.id];
          const isSelected = session.id === selectedSessionId;
          const isRunning = status?.state === "running";
          const isBusy = actionSessionId === session.id;
          const isDeleting = deletingSessionId === session.id;
          const activity = outputActivities[session.id];

          return (
            <section
              className={`session-item${isSelected ? " selected" : ""}`}
              key={session.id}
            >
              <button
                className="session-select"
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className="session-title-row">
                  <span className="session-heading">
                    <span className="session-name" title={session.name}>
                      {session.name}
                    </span>
                    <span
                      aria-hidden={activity ? undefined : true}
                      aria-label={
                        activity
                          ? `${outputActivityLabel(
                              activity.state,
                            )}: ${outputActivityDetail(activity)}`
                          : undefined
                      }
                      className={`activity-badge ${activity?.state ?? "empty"}`}
                    >
                      {activity
                        ? outputActivityLabel(activity.state)
                        : "Working"}
                    </span>
                  </span>
                  <span className={`status-pill ${isRunning ? "run" : "stop"}`}>
                    {statusLabel(status)}
                  </span>
                </span>
                <span className="session-meta" title={session.cwd}>
                  {session.cwd}
                </span>
                <span className="session-command" title={session.command}>
                  {session.command}
                </span>
              </button>
              <div className="session-actions">
                <button
                  disabled={isRunning || isBusy || isDeleting}
                  onClick={() => onStart(session.id)}
                  type="button"
                >
                  Start
                </button>
                <button
                  disabled={!isRunning || isBusy || isDeleting}
                  onClick={() => onStop(session.id)}
                  type="button"
                >
                  Stop
                </button>
                <button
                  disabled={isDeleting}
                  onClick={() => openEditEditor(session)}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="danger-button"
                  disabled={isDeleting}
                  onClick={() => void handleDeleteSession(session)}
                  type="button"
                >
                  {isDeleting ? "Deleting" : "Delete"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

type TerminalPaneProps = {
  error: string | null;
  inputRequest: TerminalInputRequest | null;
  onError: (message: string | null) => void;
  onOutput: (sessionId: string, outputAtIso?: string) => void;
  onSize: (size: TerminalSize) => void;
  onStatus: (status: RuntimeStatus) => void;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
};

function TerminalPane({
  error,
  inputRequest,
  onError,
  onOutput,
  onSize,
  onStatus,
  session,
  status,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const scrollPointerIdRef = useRef<number | null>(null);
  const statusRef = useRef<RuntimeStatus | undefined>(status);
  const terminalRef = useRef<Terminal | null>(null);
  const writeFrameRef = useRef<number | null>(null);
  const writeGenerationRef = useRef(0);
  const writeInProgressRef = useRef(false);
  const writeQueueRef = useRef("");
  const wsRef = useRef<WebSocket | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [connectionState, setConnectionState] = useState<
    "idle" | "connecting" | "connected" | "closed"
  >("idle");
  const [scrollState, setScrollState] = useState<TerminalScrollState>({
    viewportY: 0,
    baseY: 0,
  });

  const sendTerminalInput = useCallback(
    (data: string, reportErrors: boolean) => {
      const sessionId = activeSessionIdRef.current;
      const socket = wsRef.current;

      if (!data) {
        return true;
      }

      if (!sessionId) {
        if (reportErrors) {
          onError("Select a session before sending input");
        }
        return false;
      }

      if (statusRef.current?.state !== "running") {
        if (reportErrors) {
          onError("Start the selected session before sending input");
        }
        return false;
      }

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }

      socket.send(JSON.stringify({ type: "input", sessionId, data }));
      terminalRef.current?.focus();
      return true;
    },
    [onError],
  );

  const publishTerminalSize = useCallback(
    (cols: number, rows: number) => {
      const size = clampTerminalSize(cols, rows);
      onSize(size);
      return size;
    },
    [onSize],
  );

  const sendResize = useCallback((cols: number, rows: number) => {
    const sessionId = activeSessionIdRef.current;
    const socket = wsRef.current;
    const size = clampTerminalSize(cols, rows);
    if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (
      lastResizeRef.current?.cols === size.cols &&
      lastResizeRef.current.rows === size.rows
    ) {
      return;
    }

    lastResizeRef.current = size;
    socket.send(JSON.stringify({ type: "resize", sessionId, ...size }));
  }, []);

  const updateTerminalScrollState = useCallback(
    (terminal = terminalRef.current) => {
      const next = readTerminalScrollState(terminal);
      setScrollState((current) =>
        current.viewportY === next.viewportY && current.baseY === next.baseY
          ? current
          : next,
      );
    },
    [],
  );

  const scrollTerminalToClientY = useCallback(
    (clientY: number) => {
      const terminal = terminalRef.current;
      const track = scrollTrackRef.current;
      if (!terminal || !track || scrollState.baseY === 0) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const ratio = clampValue(
        ((clientY - rect.top) / rect.height) * 1000,
        0,
        1000,
      );
      terminal.scrollToLine(Math.round((ratio / 1000) * scrollState.baseY));
      updateTerminalScrollState(terminal);
    },
    [scrollState.baseY, updateTerminalScrollState],
  );

  const scrollTerminalToLine = useCallback(
    (line: number) => {
      const terminal = terminalRef.current;
      if (!terminal || scrollState.baseY === 0) {
        return;
      }

      terminal.scrollToLine(clampValue(line, 0, scrollState.baseY));
      updateTerminalScrollState(terminal);
    },
    [scrollState.baseY, updateTerminalScrollState],
  );

  const handleScrollPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollState.baseY === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      scrollPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollTerminalToClientY(event.clientY);
    },
    [scrollState.baseY, scrollTerminalToClientY],
  );

  const handleScrollPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollPointerIdRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      scrollTerminalToClientY(event.clientY);
    },
    [scrollTerminalToClientY],
  );

  const handleScrollPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollPointerIdRef.current !== event.pointerId) {
        return;
      }

      scrollPointerIdRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      scrollTerminalToClientY(event.clientY);
    },
    [scrollTerminalToClientY],
  );

  const handleScrollKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const terminal = terminalRef.current;
      if (!terminal || scrollState.baseY === 0) {
        return;
      }

      const pageStep = Math.max(1, terminal.rows - 1);
      let nextLine: number | null = null;

      switch (event.key) {
        case "ArrowUp":
          nextLine = scrollState.viewportY - 1;
          break;
        case "ArrowDown":
          nextLine = scrollState.viewportY + 1;
          break;
        case "PageUp":
          nextLine = scrollState.viewportY - pageStep;
          break;
        case "PageDown":
          nextLine = scrollState.viewportY + pageStep;
          break;
        case "Home":
          nextLine = 0;
          break;
        case "End":
          nextLine = scrollState.baseY;
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      scrollTerminalToLine(nextLine);
    },
    [scrollState.baseY, scrollState.viewportY, scrollTerminalToLine],
  );

  const handleFitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      fitAddonRef.current?.fit();
      publishTerminalSize(terminal.cols, terminal.rows);
      sendResize(terminal.cols, terminal.rows);
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      updateTerminalScrollState(terminal);
      terminal.focus();
    }
  }, [publishTerminalSize, sendResize, updateTerminalScrollState]);

  const copyTerminalSelection = useCallback(
    async (terminal: Terminal) => {
      const selection = terminal.getSelection();
      if (!selection) {
        return;
      }

      try {
        const textarea = terminal.textarea;
        let copied = false;

        if (textarea) {
          const previousValue = textarea.value;
          const previousSelectionStart = textarea.selectionStart;
          const previousSelectionEnd = textarea.selectionEnd;

          textarea.value = selection;
          textarea.focus({ preventScroll: true });
          textarea.select();
          copied = document.execCommand("copy");
          textarea.value = previousValue;

          if (
            previousSelectionStart !== null &&
            previousSelectionEnd !== null
          ) {
            textarea.setSelectionRange(
              previousSelectionStart,
              previousSelectionEnd,
            );
          }
        }

        if (!copied) {
          await writeClipboardText(selection);
        }

        terminal.clearSelection();
        terminal.focus();
        onError(null);
      } catch (error) {
        onError(messageFromError(error, "Failed to copy terminal selection"));
      }
    },
    [onError],
  );

  const pasteTerminalClipboard = useCallback(
    async (terminal: Terminal) => {
      try {
        const text = await readClipboardText();
        if (!text) {
          return;
        }
        terminal.paste(text);
        terminal.focus();
        onError(null);
      } catch (error) {
        onError(messageFromError(error, "Failed to paste clipboard"));
      }
    },
    [onError],
  );

  const flushTerminalWrites = useCallback(
    (generation: number) => {
      const terminal = terminalRef.current;
      if (
        !terminal ||
        writeInProgressRef.current ||
        generation !== writeGenerationRef.current
      ) {
        return;
      }

      const data = writeQueueRef.current;
      writeQueueRef.current = "";
      if (!data) {
        return;
      }

      writeInProgressRef.current = true;
      terminal.write(data, () => {
        writeInProgressRef.current = false;
        updateTerminalScrollState(terminal);
        if (
          generation !== writeGenerationRef.current ||
          !writeQueueRef.current
        ) {
          return;
        }

        writeFrameRef.current = window.requestAnimationFrame(() => {
          writeFrameRef.current = null;
          flushTerminalWrites(generation);
        });
      });
    },
    [updateTerminalScrollState],
  );

  const scheduleTerminalWriteFlush = useCallback(() => {
    if (writeFrameRef.current !== null || writeInProgressRef.current) {
      return;
    }

    const generation = writeGenerationRef.current;
    writeFrameRef.current = window.requestAnimationFrame(() => {
      writeFrameRef.current = null;
      flushTerminalWrites(generation);
    });
  }, [flushTerminalWrites]);

  const queueTerminalWrite = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      writeQueueRef.current += data;
      scheduleTerminalWriteFlush();
    },
    [scheduleTerminalWriteFlush],
  );

  const resetTerminalOutput = useCallback(
    (terminal: Terminal) => {
      writeGenerationRef.current += 1;
      writeQueueRef.current = "";
      writeInProgressRef.current = false;

      if (writeFrameRef.current !== null) {
        window.cancelAnimationFrame(writeFrameRef.current);
        writeFrameRef.current = null;
      }

      terminal.reset();
      updateTerminalScrollState(terminal);
    },
    [updateTerminalScrollState],
  );

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 100000,
      theme: {
        background: "#111315",
        black: "#111315",
        blue: "#5ba8ff",
        brightBlack: "#666f7a",
        brightBlue: "#8ec5ff",
        brightCyan: "#8adfd9",
        brightGreen: "#91d18b",
        brightMagenta: "#e3a5f3",
        brightRed: "#ff8b8b",
        brightWhite: "#f8fafc",
        brightYellow: "#ffd27a",
        cyan: "#61c5bf",
        foreground: "#d8dee9",
        green: "#74b86f",
        magenta: "#c67edb",
        red: "#ef7373",
        white: "#d8dee9",
        yellow: "#e8b457",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    try {
      terminal.loadAddon(new CanvasAddon());
    } catch {
      // Fall back to the default DOM renderer if canvas is unavailable.
    }
    fitAddon.fit();
    publishTerminalSize(terminal.cols, terminal.rows);
    updateTerminalScrollState(terminal);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || event.altKey) {
        return true;
      }

      const key = event.key.toLowerCase();
      const isCopyShortcut = key === "c" && terminal.hasSelection();
      const isPasteShortcut = key === "v";

      if (!isCopyShortcut && !isPasteShortcut) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();
      if (isCopyShortcut) {
        void copyTerminalSelection(terminal);
      } else {
        void pasteTerminalClipboard(terminal);
      }
      return false;
    });

    const inputDisposable = terminal.onData((data) => {
      sendTerminalInput(data, false);
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      publishTerminalSize(cols, rows);
      sendResize(cols, rows);
      updateTerminalScrollState(terminal);
    });

    const scrollDisposable = terminal.onScroll(() => {
      updateTerminalScrollState(terminal);
    });
    const viewport = container.querySelector(".xterm-viewport");
    const handleViewportScroll = () => {
      updateTerminalScrollState(terminal);
    };
    viewport?.addEventListener("scroll", handleViewportScroll, {
      passive: true,
    });

    return () => {
      writeGenerationRef.current += 1;
      writeQueueRef.current = "";
      writeInProgressRef.current = false;
      if (writeFrameRef.current !== null) {
        window.cancelAnimationFrame(writeFrameRef.current);
        writeFrameRef.current = null;
      }
      viewport?.removeEventListener("scroll", handleViewportScroll);
      scrollDisposable.dispose();
      resizeDisposable.dispose();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setScrollState({ viewportY: 0, baseY: 0 });
    };
  }, [
    copyTerminalSelection,
    pasteTerminalClipboard,
    publishTerminalSize,
    sendResize,
    sendTerminalInput,
    updateTerminalScrollState,
  ]);

  useEffect(() => {
    const target = containerRef.current;
    const fitAddon = fitAddonRef.current;
    if (!target || !fitAddon) {
      return undefined;
    }

    let resizeFrame: number | null = null;
    const fit = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const terminal = terminalRef.current;
        fitAddon.fit();
        if (terminal) {
          publishTerminalSize(terminal.cols, terminal.rows);
          sendResize(terminal.cols, terminal.rows);
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          updateTerminalScrollState(terminal);
        }
      });
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(target);
    fit();

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver.disconnect();
    };
  }, [publishTerminalSize, sendResize, updateTerminalScrollState]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const sessionId = session?.id ?? null;
    activeSessionIdRef.current = sessionId;
    lastResizeRef.current = null;

    if (!terminal || !sessionId) {
      setConnectionState("idle");
      setScrollState({ viewportY: 0, baseY: 0 });
      return undefined;
    }

    onError(null);
    resetTerminalOutput(terminal);
    setConnectionState("connecting");

    const socket = new WebSocket(wsUrl());
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ type: "subscribe", sessionId, includeBuffer: true }),
      );
      sendResize(terminal.cols, terminal.rows);
      setConnectionState("connected");
    });

    socket.addEventListener("message", (event) => {
      let message: WsMessage;
      try {
        message = JSON.parse(String(event.data)) as WsMessage;
      } catch {
        onError("Received invalid WebSocket message");
        return;
      }

      if (message.type === "error") {
        onError(message.error.message);
        return;
      }

      if ("sessionId" in message && message.sessionId !== sessionId) {
        return;
      }

      switch (message.type) {
        case "subscribed":
          resetTerminalOutput(terminal);
          if (message.buffer) {
            queueTerminalWrite(message.buffer);
          }
          onStatus(message.status);
          publishTerminalSize(terminal.cols, terminal.rows);
          sendResize(terminal.cols, terminal.rows);
          break;
        case "terminal.output":
          queueTerminalWrite(message.data);
          onOutput(message.sessionId, message.at);
          break;
        case "session.status":
          onStatus(message.status);
          break;
        case "unsubscribed":
          break;
      }
    });

    socket.addEventListener("close", () => {
      if (wsRef.current === socket) {
        setConnectionState("closed");
      }
    });

    socket.addEventListener("error", () => {
      onError("WebSocket connection failed");
    });

    return () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe", sessionId }));
      }
      socket.close();
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
    };
  }, [
    onError,
    onOutput,
    onStatus,
    publishTerminalSize,
    queueTerminalWrite,
    resetTerminalOutput,
    sendResize,
    session?.id,
  ]);

  useEffect(() => {
    if (!inputRequest) {
      return;
    }

    sendTerminalInput(inputRequest.data, true);
  }, [inputRequest, sendTerminalInput]);

  const running = status?.state === "running";
  const hasScrollback = scrollState.baseY > 0;
  const scrollProgress = hasScrollback
    ? scrollState.viewportY / scrollState.baseY
    : 0;
  const scrollThumbTop = `calc(${(scrollProgress * 100).toFixed(3)}% - ${(
    scrollProgress * 34
  ).toFixed(1)}px)`;

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <header className="terminal-header">
        <div>
          <p className="eyebrow">Terminal</p>
          <h2>{session?.name ?? "No session selected"}</h2>
        </div>
        <div className="terminal-header-actions">
          <button
            className="ghost-button compact"
            disabled={!session}
            onClick={handleFitTerminal}
            title="Fit terminal size"
            type="button"
          >
            Fit
          </button>
          <div className="terminal-stats">
            <span className={`status-dot ${running ? "run" : "stop"}`} />
            <span>{statusLabel(status)}</span>
            <span>WS {connectionState}</span>
          </div>
        </div>
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
      <div
        className="terminal-frame"
        onClick={() => terminalRef.current?.focus()}
      >
        <div className="terminal-host" ref={containerRef} />
        <div className="terminal-scroll-rail" aria-hidden={!hasScrollback}>
          <div
            aria-disabled={!hasScrollback}
            aria-label="Terminal scrollback"
            aria-orientation="vertical"
            aria-valuemax={scrollState.baseY}
            aria-valuemin={0}
            aria-valuenow={scrollState.viewportY}
            className={`terminal-scroll-control${
              hasScrollback ? "" : " disabled"
            }`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleScrollKeyDown}
            onPointerCancel={handleScrollPointerUp}
            onPointerDown={handleScrollPointerDown}
            onPointerMove={handleScrollPointerMove}
            onPointerUp={handleScrollPointerUp}
            ref={scrollTrackRef}
            role="scrollbar"
            tabIndex={hasScrollback ? 0 : -1}
            title="Drag to scroll terminal history"
          >
            <span
              className="terminal-scroll-thumb"
              style={{ top: scrollThumbTop }}
            />
          </div>
        </div>
      </div>
      <footer className="terminal-footer">
        <span>PID {status?.pid ?? "-"}</span>
        <span>Started {formatDate(status?.startedAt ?? null)}</span>
        <span>Last output {formatDate(status?.lastOutputAt ?? null)}</span>
        <span>Buffer {status?.bufferLength ?? 0}</span>
      </footer>
    </section>
  );
}

type PromptExamplesProps = {
  onTerminalInput: (data: string) => void;
  onUpdatePrompts: (prompts: PromptExample[]) => Promise<PromptExample[]>;
  prompts: PromptExample[];
  promptsLoaded: boolean;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
};

type PromptDraft = {
  id: string;
  title: string;
  text: string;
};

type PromptEditorState = {
  mode: "create" | "edit";
  originalId: string | null;
};

type PromptDraftCacheEntry = {
  draft: PromptDraft;
  editor: PromptEditorState;
  updatedAt: number;
};

const promptDraftCacheKey = "termrail.promptDraft.v2";

function newPromptDraft(): PromptDraft {
  return {
    id: makeLocalId("prompt"),
    title: "",
    text: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function promptDraftFromUnknown(value: unknown): PromptDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, title, text } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof text !== "string"
  ) {
    return null;
  }

  return { id, title, text };
}

function promptEditorFromUnknown(value: unknown): PromptEditorState | null {
  if (!isRecord(value)) {
    return null;
  }

  const mode = value.mode;
  const originalId = value.originalId;
  if (
    (mode !== "create" && mode !== "edit") ||
    (originalId !== null && typeof originalId !== "string")
  ) {
    return null;
  }

  return { mode, originalId };
}

function readPromptDraftCacheEntry(): PromptDraftCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(promptDraftCacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const draft = promptDraftFromUnknown(parsed.draft);
    const editor = promptEditorFromUnknown(parsed.editor);
    const updatedAt =
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0;

    return draft && editor ? { draft, editor, updatedAt } : null;
  } catch {
    return null;
  }
}

function writePromptDraftCacheEntry(entry: PromptDraftCacheEntry): void {
  try {
    window.localStorage.setItem(promptDraftCacheKey, JSON.stringify(entry));
  } catch {
    // Draft persistence is best-effort.
  }
}

function clearPromptDraftCacheEntry(): void {
  try {
    window.localStorage.removeItem(promptDraftCacheKey);
  } catch {
    // Draft persistence is best-effort.
  }
}

function draftFromPrompt(prompt: PromptExample): PromptDraft {
  return {
    id: prompt.id,
    title: prompt.title,
    text: prompt.text,
  };
}

function PromptExamples({
  onTerminalInput,
  onUpdatePrompts,
  prompts,
  promptsLoaded,
  session,
  status,
}: PromptExamplesProps) {
  const running = status?.state === "running";
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(() => newPromptDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyingPromptId, setCopyingPromptId] = useState<string | null>(null);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);

  useEffect(() => {
    if (!promptsLoaded) {
      return;
    }

    const cached = readPromptDraftCacheEntry();
    const cachedPromptExists =
      cached?.editor.mode === "create" ||
      prompts.some((prompt) => prompt.id === cached?.editor.originalId);
    if (cached && cachedPromptExists) {
      setEditor(cached.editor);
      setDraft(cached.draft);
    } else {
      setEditor(null);
      setDraft(newPromptDraft());
    }
    setFormError(null);
    setNotice(null);
  }, [prompts, promptsLoaded]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    writePromptDraftCacheEntry({
      draft,
      editor,
      updatedAt: Date.now(),
    });
  }, [draft, editor]);

  const updateDraft = (field: keyof PromptDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const closePromptEditor = () => {
    clearPromptDraftCacheEntry();
    setEditor(null);
    setDraft(newPromptDraft());
    setFormError(null);
  };

  const openCreateEditor = () => {
    clearPromptDraftCacheEntry();
    setEditor({ mode: "create", originalId: null });
    setDraft(newPromptDraft());
    setFormError(null);
    setNotice(null);
  };

  const openEditEditor = (prompt: PromptExample) => {
    clearPromptDraftCacheEntry();
    setEditor({ mode: "edit", originalId: prompt.id });
    setDraft(draftFromPrompt(prompt));
    setFormError(null);
    setNotice(null);
  };

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) {
      return;
    }

    const prompt: PromptExample = {
      id: draft.id.trim(),
      title: draft.title.trim(),
      text: draft.text,
    };

    if (!prompt.id || !prompt.title) {
      setFormError("id and title are required");
      return;
    }

    const duplicate = prompts.some(
      (item) => item.id === prompt.id && item.id !== editor.originalId,
    );
    if (duplicate) {
      setFormError(`Prompt id "${prompt.id}" already exists`);
      return;
    }

    const nextPrompts =
      editor.mode === "create"
        ? [...prompts, prompt]
        : prompts.map((item) =>
            item.id === editor.originalId ? prompt : item,
          );

    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      await onUpdatePrompts(nextPrompts);
      clearPromptDraftCacheEntry();
      setEditor(null);
      setDraft(newPromptDraft());
    } catch (error) {
      setFormError(messageFromError(error, "Failed to save prompt"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePrompt = async (prompt: PromptExample) => {
    const confirmed = window.confirm(`Delete prompt "${prompt.title}"?`);
    if (!confirmed) {
      return;
    }

    setDeletingPromptId(prompt.id);
    setFormError(null);
    setNotice(null);
    try {
      await onUpdatePrompts(prompts.filter((item) => item.id !== prompt.id));
      if (editor?.originalId === prompt.id) {
        clearPromptDraftCacheEntry();
        setEditor(null);
        setDraft(newPromptDraft());
      }
    } catch (error) {
      setFormError(messageFromError(error, "Failed to delete prompt"));
    } finally {
      setDeletingPromptId(null);
    }
  };

  const handleCopyPrompt = async (prompt: PromptExample) => {
    setCopyingPromptId(prompt.id);
    setFormError(null);
    setNotice(null);
    try {
      await writeClipboardText(prompt.text);
      setNotice(`Copied "${prompt.title}"`);
    } catch (error) {
      setFormError(messageFromError(error, "Failed to copy prompt"));
    } finally {
      setCopyingPromptId(null);
    }
  };

  return (
    <aside className="prompt-panel" aria-label="Prompt examples">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Editable</p>
          <h2>Prompt Examples</h2>
        </div>
        <button
          className="primary-button"
          disabled={!promptsLoaded}
          onClick={openCreateEditor}
          type="button"
        >
          Add
        </button>
      </div>

      {editor ? (
        <form className="side-form" onSubmit={handlePromptSubmit}>
          <div className="form-title-row">
            <h2>{editor.mode === "create" ? "Add Prompt" : "Edit Prompt"}</h2>
            <button
              className="ghost-button compact"
              disabled={saving}
              onClick={closePromptEditor}
              type="button"
            >
              Close
            </button>
          </div>
          {formError ? <div className="form-error">{formError}</div> : null}
          <label>
            <span>ID</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("id", event.target.value)}
              required
              value={draft.id}
            />
          </label>
          <label>
            <span>Title</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("title", event.target.value)}
              required
              value={draft.title}
            />
          </label>
          <label>
            <span>Text</span>
            <textarea
              disabled={saving}
              onChange={(event) => updateDraft("text", event.target.value)}
              rows={8}
              value={draft.text}
            />
          </label>
          <div className="form-actions">
            <button className="primary-button" disabled={saving} type="submit">
              {saving ? "Saving" : "Save"}
            </button>
            <button
              className="ghost-button"
              disabled={saving}
              onClick={closePromptEditor}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {formError && !editor ? (
        <div className="form-error">{formError}</div>
      ) : null}
      {notice ? <div className="form-notice">{notice}</div> : null}

      <div className="prompt-list">
        {!promptsLoaded ? (
          <p className="empty-state">Loading prompt examples...</p>
        ) : null}
        {promptsLoaded && prompts.length === 0 ? (
          <p className="empty-state">No prompt examples configured.</p>
        ) : null}
        {promptsLoaded &&
          prompts.map((prompt) => (
            <article className="prompt-item" key={prompt.id}>
              <div className="prompt-title-row">
                <div>
                  <h3>{prompt.title}</h3>
                  <span className="prompt-id">{prompt.id}</span>
                </div>
              </div>
              <pre>{prompt.text || "(empty prompt)"}</pre>
              <div className="prompt-actions">
                <button
                  disabled={copyingPromptId === prompt.id}
                  onClick={() => void handleCopyPrompt(prompt)}
                  type="button"
                >
                  {copyingPromptId === prompt.id ? "Copying" : "Copy"}
                </button>
                <button
                  disabled={!running}
                  onClick={() => onTerminalInput(prompt.text)}
                  type="button"
                >
                  Insert
                </button>
                <button
                  disabled={!running}
                  onClick={() => onTerminalInput(`${prompt.text}\r`)}
                  type="button"
                >
                  Send
                </button>
                <button onClick={() => openEditEditor(prompt)} type="button">
                  Edit
                </button>
                <button
                  className="danger-button"
                  disabled={deletingPromptId === prompt.id}
                  onClick={() => void handleDeletePrompt(prompt)}
                  type="button"
                >
                  {deletingPromptId === prompt.id ? "Deleting" : "Delete"}
                </button>
              </div>
            </article>
          ))}
      </div>
    </aside>
  );
}

export function App() {
  return <AppShell />;
}
