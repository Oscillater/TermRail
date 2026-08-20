import {
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
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

type StatusResponse = {
  status: RuntimeStatus;
};

type WsMessage =
  | {
      type: "subscribed";
      sessionId: string;
      status: RuntimeStatus;
      buffer: string;
    }
  | { type: "unsubscribed"; sessionId: string }
  | { type: "terminal.output"; sessionId: string; data: string }
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

function apiHeaders(): HeadersInit {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
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

function statusLabel(status: RuntimeStatus | undefined): string {
  return status?.state === "running" ? "Running" : "Stopped";
}

function AppShell() {
  const [sessions, setSessions] = useState<SessionConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedSession = useMemo(
    () =>
      sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedStatus = selectedSessionId
    ? statuses[selectedSessionId]
    : undefined;

  const updateStatus = useCallback((status: RuntimeStatus) => {
    setStatuses((current) => ({ ...current, [status.sessionId]: status }));
  }, []);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<SessionsResponse>("/api/sessions");
      setSessions(data.sessions);
      setStatuses(data.statuses);
      setSelectedSessionId((current) => {
        if (current && data.sessions.some((session) => session.id === current)) {
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

  const runAction = useCallback(
    async (sessionId: string, action: "start" | "stop") => {
      setActionSessionId(sessionId);
      setError(null);
      try {
        const data = await apiRequest<StatusResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
          { method: "POST" },
        );
        updateStatus(data.status);
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
    [updateStatus],
  );

  return (
    <main className="app-shell">
      <SessionList
        actionSessionId={actionSessionId}
        loading={loading}
        onRefresh={loadSessions}
        onSelect={setSelectedSessionId}
        onStart={(sessionId) => void runAction(sessionId, "start")}
        onStop={(sessionId) => void runAction(sessionId, "stop")}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
        statuses={statuses}
      />
      <TerminalPane
        error={error}
        onError={setError}
        onStatus={updateStatus}
        session={selectedSession}
        status={selectedStatus}
      />
      <PromptExamples session={selectedSession} />
    </main>
  );
}

type SessionListProps = {
  actionSessionId: string | null;
  loading: boolean;
  onRefresh: () => void;
  onSelect: (sessionId: string) => void;
  onStart: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  selectedSessionId: string | null;
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

function SessionList({
  actionSessionId,
  loading,
  onRefresh,
  onSelect,
  onStart,
  onStop,
  selectedSessionId,
  sessions,
  statuses,
}: SessionListProps) {
  return (
    <aside className="session-panel" aria-label="Sessions">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Switchboard</p>
          <h1>Sessions</h1>
        </div>
        <button className="ghost-button" onClick={onRefresh} type="button">
          Refresh
        </button>
      </div>

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
                  <span className="session-name">{session.name}</span>
                  <span className={`status-pill ${isRunning ? "run" : "stop"}`}>
                    {statusLabel(status)}
                  </span>
                </span>
                <span className="session-meta">{session.cwd}</span>
                <span className="session-command">{session.command}</span>
              </button>
              <div className="session-actions">
                <button
                  disabled={isRunning || isBusy}
                  onClick={() => onStart(session.id)}
                  type="button"
                >
                  Start
                </button>
                <button
                  disabled={!isRunning || isBusy}
                  onClick={() => onStop(session.id)}
                  type="button"
                >
                  Stop
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
  onError: (message: string | null) => void;
  onStatus: (status: RuntimeStatus) => void;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
};

function TerminalPane({
  error,
  onError,
  onStatus,
  session,
  status,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
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

  const flushTerminalWrites = useCallback((generation: number) => {
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
  }, []);

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

  const resetTerminalOutput = useCallback((terminal: Terminal) => {
    writeGenerationRef.current += 1;
    writeQueueRef.current = "";
    writeInProgressRef.current = false;

    if (writeFrameRef.current !== null) {
      window.cancelAnimationFrame(writeFrameRef.current);
      writeFrameRef.current = null;
    }

    terminal.reset();
  }, []);

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
      scrollback: 20000,
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

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      const sessionId = activeSessionIdRef.current;
      const socket = wsRef.current;
      if (
        !sessionId ||
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        statusRef.current?.state !== "running"
      ) {
        return;
      }
      socket.send(JSON.stringify({ type: "input", sessionId, data }));
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    return () => {
      writeGenerationRef.current += 1;
      writeQueueRef.current = "";
      writeInProgressRef.current = false;
      if (writeFrameRef.current !== null) {
        window.cancelAnimationFrame(writeFrameRef.current);
        writeFrameRef.current = null;
      }
      resizeDisposable.dispose();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sendResize]);

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
        fitAddon.fit();
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
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    const sessionId = session?.id ?? null;
    activeSessionIdRef.current = sessionId;
    lastResizeRef.current = null;

    if (!terminal || !sessionId) {
      setConnectionState("idle");
      return undefined;
    }

    onError(null);
    resetTerminalOutput(terminal);
    setConnectionState("connecting");

    const socket = new WebSocket(wsUrl());
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", sessionId }));
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
          sendResize(terminal.cols, terminal.rows);
          break;
        case "terminal.output":
          queueTerminalWrite(message.data);
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
    onStatus,
    queueTerminalWrite,
    resetTerminalOutput,
    sendResize,
    session?.id,
  ]);

  const running = status?.state === "running";

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <header className="terminal-header">
        <div>
          <p className="eyebrow">Terminal</p>
          <h2>{session?.name ?? "No session selected"}</h2>
        </div>
        <div className="terminal-header-actions">
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
  session: SessionConfig | null;
};

function PromptExamples({ session }: PromptExamplesProps) {
  const prompts = session?.prompts ?? [];

  return (
    <aside className="prompt-panel" aria-label="Prompt examples">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Read Only</p>
          <h2>Prompt Examples</h2>
        </div>
      </div>
      <div className="prompt-list">
        {!session ? (
          <p className="empty-state">Select a session to view prompts.</p>
        ) : null}
        {session && prompts.length === 0 ? (
          <p className="empty-state">No prompt examples configured.</p>
        ) : null}
        {prompts.map((prompt) => (
          <article className="prompt-item" key={prompt.id}>
            <h3>{prompt.title}</h3>
            <pre>{prompt.text || "(empty prompt)"}</pre>
          </article>
        ))}
      </div>
    </aside>
  );
}

export function App() {
  return <AppShell />;
}
