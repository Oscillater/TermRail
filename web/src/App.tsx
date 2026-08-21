import {
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
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
};

type SessionResponse = {
  session: SessionConfig;
};

type StatusResponse = {
  status: RuntimeStatus;
};

type TerminalInputRequest = {
  id: number;
  data: string;
};

type TerminalSize = {
  cols: number;
  rows: number;
};

type UnreadCounts = Record<string, number>;

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
const notificationPreferenceKey = "codex-switchboard.notificationsEnabled";

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

function browserNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function getNotificationPermission(): NotificationPermission {
  return browserNotificationsSupported() ? Notification.permission : "denied";
}

function readNotificationEnabledPreference(): boolean {
  if (
    !browserNotificationsSupported() ||
    Notification.permission !== "granted"
  ) {
    return false;
  }

  try {
    return window.localStorage.getItem(notificationPreferenceKey) === "true";
  } catch {
    return false;
  }
}

function writeNotificationEnabledPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(notificationPreferenceKey, String(enabled));
  } catch {
    // Notification preference persistence is best-effort.
  }
}

function notificationStatusLabel(
  supported: boolean,
  enabled: boolean,
  permission: NotificationPermission,
): string {
  if (!supported) {
    return "Unsupported";
  }
  if (enabled && permission === "granted") {
    return "On";
  }
  if (permission === "denied") {
    return "Blocked";
  }
  return "Off";
}

function AppShell() {
  const [sessions, setSessions] = useState<SessionConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>({});
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    readNotificationEnabledPreference,
  );
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(getNotificationPermission);
  const [loading, setLoading] = useState(true);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalInputRequest, setTerminalInputRequest] =
    useState<TerminalInputRequest | null>(null);
  const [terminalSize, setTerminalSize] = useState<TerminalSize | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionConfig[]>([]);
  const statusesRef = useRef<Record<string, RuntimeStatus>>({});
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const terminalInputRequestIdRef = useRef(0);
  const notificationsSupported = browserNotificationsSupported();

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedStatus = selectedSessionId
    ? statuses[selectedSessionId]
    : undefined;

  const runningSessionIdsKey = useMemo(
    () =>
      JSON.stringify(
        sessions
          .filter((session) => statuses[session.id]?.state === "running")
          .map((session) => session.id),
      ),
    [sessions, statuses],
  );

  const updateStatus = useCallback((status: RuntimeStatus) => {
    setStatuses((current) => ({ ...current, [status.sessionId]: status }));
  }, []);

  const clearUnread = useCallback((sessionId: string) => {
    setUnreadCounts((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      selectedSessionIdRef.current = sessionId;
      setSelectedSessionId(sessionId);
      clearUnread(sessionId);
    },
    [clearUnread],
  );

  const upsertSession = useCallback((session: SessionConfig) => {
    setSessions((current) => {
      const existingIndex = current.findIndex((item) => item.id === session.id);
      if (existingIndex === -1) {
        return [...current, session];
      }

      return current.map((item) => (item.id === session.id ? session : item));
    });
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
      setSessions(data.sessions);
      setStatuses(data.statuses);
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
    selectedSessionIdRef.current = selectedSessionId;
    if (selectedSessionId) {
      clearUnread(selectedSessionId);
    }
  }, [clearUnread, selectedSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
    const sessionIds = new Set(sessions.map((session) => session.id));
    setUnreadCounts((current) => {
      let changed = false;
      const next: UnreadCounts = {};
      Object.entries(current).forEach(([sessionId, count]) => {
        if (sessionIds.has(sessionId)) {
          next[sessionId] = count;
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    statusesRef.current = statuses;
  }, [statuses]);

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  const showOutputNotification = useCallback((sessionId: string) => {
    if (
      !notificationsEnabledRef.current ||
      !browserNotificationsSupported() ||
      Notification.permission !== "granted"
    ) {
      return;
    }

    const sessionName =
      sessionsRef.current.find((session) => session.id === sessionId)?.name ??
      sessionId;
    try {
      new Notification(`${sessionName} has new output`, {
        tag: `codex-switchboard-${sessionId}-output`,
      });
    } catch {
      // Browsers may still reject construction despite a granted permission.
    }
  }, []);

  const handleInactiveOutput = useCallback(
    (sessionId: string) => {
      if (sessionId === selectedSessionIdRef.current) {
        return;
      }

      if (statusesRef.current[sessionId]?.state !== "running") {
        return;
      }

      setUnreadCounts((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? 0) + 1,
      }));
      showOutputNotification(sessionId);
    },
    [showOutputNotification],
  );

  useEffect(() => {
    const sessionIds = JSON.parse(runningSessionIdsKey) as string[];
    if (sessionIds.length === 0) {
      return undefined;
    }

    let closed = false;
    const socket = new WebSocket(wsUrl());

    socket.addEventListener("open", () => {
      if (closed) {
        return;
      }
      sessionIds.forEach((sessionId) => {
        socket.send(JSON.stringify({ type: "subscribe", sessionId }));
      });
    });

    socket.addEventListener("message", (event) => {
      let message: WsMessage;
      try {
        message = JSON.parse(String(event.data)) as WsMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "subscribed":
          updateStatus(message.status);
          break;
        case "terminal.output":
          handleInactiveOutput(message.sessionId);
          break;
        case "session.status":
          updateStatus(message.status);
          break;
        case "error":
        case "unsubscribed":
          break;
      }
    });

    return () => {
      closed = true;
      if (socket.readyState === WebSocket.OPEN) {
        sessionIds.forEach((sessionId) => {
          socket.send(JSON.stringify({ type: "unsubscribe", sessionId }));
        });
      }
      socket.close();
    };
  }, [handleInactiveOutput, runningSessionIdsKey, updateStatus]);

  const toggleNotifications = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        setNotificationsEnabled(false);
        setNotificationPermission(getNotificationPermission());
        writeNotificationEnabledPreference(false);
        return;
      }

      if (!notificationsSupported) {
        setNotificationsEnabled(false);
        setNotificationPermission("denied");
        writeNotificationEnabledPreference(false);
        setError("Browser notifications are not supported");
        return;
      }

      setError(null);
      let permission = Notification.permission;
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }

      setNotificationPermission(permission);
      const granted = permission === "granted";
      setNotificationsEnabled(granted);
      writeNotificationEnabledPreference(granted);
      if (!granted) {
        setError(
          permission === "denied"
            ? "Browser notifications are blocked"
            : "Browser notifications were not enabled",
        );
      }
    },
    [notificationsSupported],
  );

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
    [terminalSize, updateStatus],
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
        return next;
      });
      setUnreadCounts((current) => {
        if (!current[sessionId]) {
          return current;
        }
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    },
    [sessions],
  );

  const updatePrompts = useCallback(
    async (sessionId: string, prompts: PromptExample[]) => {
      setError(null);
      const data = await apiRequest<SessionResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ prompts }),
        },
      );
      upsertSession(data.session);
      return data.session;
    },
    [upsertSession],
  );

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
        onToggleNotifications={(enabled) => void toggleNotifications(enabled)}
        notificationPermission={notificationPermission}
        notificationsEnabled={notificationsEnabled}
        notificationsSupported={notificationsSupported}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
        statuses={statuses}
        unreadCounts={unreadCounts}
      />
      <TerminalPane
        error={error}
        inputRequest={terminalInputRequest}
        onError={setError}
        onSize={setTerminalSize}
        onStatus={updateStatus}
        session={selectedSession}
        status={selectedStatus}
      />
      <PromptExamples
        onTerminalInput={requestTerminalInput}
        onUpdatePrompts={updatePrompts}
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
  onToggleNotifications: (enabled: boolean) => void;
  notificationPermission: NotificationPermission;
  notificationsEnabled: boolean;
  notificationsSupported: boolean;
  selectedSessionId: string | null;
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
  unreadCounts: UnreadCounts;
};

type SessionDraft = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  promptsJson: string;
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
    promptsJson: "[]",
  };
}

function draftFromSession(session: SessionConfig): SessionDraft {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    command: session.command,
    promptsJson: JSON.stringify(session.prompts, null, 2),
  };
}

function parsePromptsJson(value: string): PromptExample[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("prompts must be a JSON array");
  }

  return parsed as PromptExample[];
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
  onToggleNotifications,
  notificationPermission,
  notificationsEnabled,
  notificationsSupported,
  selectedSessionId,
  sessions,
  statuses,
  unreadCounts,
}: SessionListProps) {
  const [editor, setEditor] = useState<SessionEditorState | null>(null);
  const [draft, setDraft] = useState<SessionDraft>(() => newSessionDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
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

    let prompts: PromptExample[];
    try {
      prompts = parsePromptsJson(draft.promptsJson);
    } catch (error) {
      setFormError(messageFromError(error, "Invalid prompts JSON"));
      return;
    }

    const session: SessionConfig = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      cwd: draft.cwd.trim(),
      command: draft.command.trim(),
      prompts,
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
          <p className="eyebrow">Switchboard</p>
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

      <div className="notification-row">
        <label className="notification-toggle">
          <input
            checked={notificationsEnabled}
            disabled={!notificationsSupported}
            onChange={(event) =>
              onToggleNotifications(event.currentTarget.checked)
            }
            type="checkbox"
          />
          <span className="toggle-track" aria-hidden="true">
            <span />
          </span>
          <span>Notifications</span>
        </label>
        <span className="notification-state">
          {notificationStatusLabel(
            notificationsSupported,
            notificationsEnabled,
            notificationPermission,
          )}
        </span>
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
          <label>
            <span>Prompts</span>
            <textarea
              disabled={saving}
              onChange={(event) =>
                updateDraft("promptsJson", event.target.value)
              }
              rows={7}
              spellCheck={false}
              value={draft.promptsJson}
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
          const unreadCount = unreadCounts[session.id] ?? 0;
          const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);

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
                    <span className="session-name">{session.name}</span>
                    {unreadCount > 0 ? (
                      <span
                        aria-label={`${unreadCount} unread output events`}
                        className="unread-badge"
                      >
                        {unreadLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className={`status-pill ${isRunning ? "run" : "stop"}`}>
                    {statusLabel(status)}
                  </span>
                </span>
                <span className="session-meta">{session.cwd}</span>
                <span className="session-command">{session.command}</span>
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
  onSize: (size: TerminalSize) => void;
  onStatus: (status: RuntimeStatus) => void;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
};

function TerminalPane({
  error,
  inputRequest,
  onError,
  onSize,
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

  const handleRedraw = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      fitAddonRef.current?.fit();
      publishTerminalSize(terminal.cols, terminal.rows);
      sendResize(terminal.cols, terminal.rows);
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      terminal.focus();
    }
    sendTerminalInput("\x0c", true);
  }, [publishTerminalSize, sendResize, sendTerminalInput]);

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
      if (generation !== writeGenerationRef.current || !writeQueueRef.current) {
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
    publishTerminalSize(terminal.cols, terminal.rows);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      sendTerminalInput(data, false);
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      publishTerminalSize(cols, rows);
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
  }, [publishTerminalSize, sendResize, sendTerminalInput]);

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
  }, [publishTerminalSize, sendResize]);

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
          publishTerminalSize(terminal.cols, terminal.rows);
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
            disabled={!running}
            onClick={handleRedraw}
            type="button"
          >
            Redraw
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
  onUpdatePrompts: (
    sessionId: string,
    prompts: PromptExample[],
  ) => Promise<SessionConfig>;
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

function newPromptDraft(): PromptDraft {
  return {
    id: makeLocalId("prompt"),
    title: "",
    text: "",
  };
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
  session,
  status,
}: PromptExamplesProps) {
  const prompts = session?.prompts ?? [];
  const running = status?.state === "running";
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(() => newPromptDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyingPromptId, setCopyingPromptId] = useState<string | null>(null);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);

  useEffect(() => {
    setEditor(null);
    setDraft(newPromptDraft());
    setFormError(null);
    setNotice(null);
  }, [session?.id]);

  const updateDraft = (field: keyof PromptDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const openCreateEditor = () => {
    setEditor({ mode: "create", originalId: null });
    setDraft(newPromptDraft());
    setFormError(null);
    setNotice(null);
  };

  const openEditEditor = (prompt: PromptExample) => {
    setEditor({ mode: "edit", originalId: prompt.id });
    setDraft(draftFromPrompt(prompt));
    setFormError(null);
    setNotice(null);
  };

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !editor) {
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
      await onUpdatePrompts(session.id, nextPrompts);
      setEditor(null);
    } catch (error) {
      setFormError(messageFromError(error, "Failed to save prompt"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePrompt = async (prompt: PromptExample) => {
    if (!session) {
      return;
    }

    const confirmed = window.confirm(`Delete prompt "${prompt.title}"?`);
    if (!confirmed) {
      return;
    }

    setDeletingPromptId(prompt.id);
    setFormError(null);
    setNotice(null);
    try {
      await onUpdatePrompts(
        session.id,
        prompts.filter((item) => item.id !== prompt.id),
      );
      if (editor?.originalId === prompt.id) {
        setEditor(null);
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
          disabled={!session}
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
              onClick={() => setEditor(null)}
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
              onClick={() => setEditor(null)}
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
        {!session ? (
          <p className="empty-state">Select a session to view prompts.</p>
        ) : null}
        {session && prompts.length === 0 ? (
          <p className="empty-state">No prompt examples configured.</p>
        ) : null}
        {prompts.map((prompt) => (
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
