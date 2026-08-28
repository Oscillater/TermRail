import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsonHeaders, jsonRequest } from "./api";
import { useSessionStream } from "./hooks/useSessionStream";
import type {
  PromptsResponse,
  RuntimeStatus,
  SessionConfig,
  SessionResponse,
  SessionsResponse,
  StatusesResponse,
  StatusResponse,
  TerminalInputRequest,
  TerminalSize,
} from "./types";
import {
  collectOutputActivities,
  collectSessionPrompts,
  defaultRuntimeStatus,
  mergeRuntimeStatus,
  statusRefreshIntervalMs,
  timestampFromIso,
} from "./utils/activity";

export function useAppController() {
  const [prompts, setPrompts] = useState<PromptsResponse["prompts"]>([]);
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
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
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

  const sessionIds = useMemo(
    () => sessions.map((session) => session.id),
    [sessions],
  );

  const outputActivities = useMemo(
    () =>
      collectOutputActivities(
        sessions,
        statuses,
        activityAcknowledgedAt,
        activityNow,
      ),
    [activityAcknowledgedAt, activityNow, sessions, statuses],
  );

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
    setSessionError(null);
    try {
      const data = await jsonRequest<SessionsResponse>("/api/sessions");
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
      setSessionError(
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
      const data = await jsonRequest<StatusesResponse>("/api/status");
      Object.values(data.statuses).forEach(handleSessionStatus);
      setActivityNow(Date.now());
    } catch {
      // The WebSocket is still the primary live channel; polling is best-effort.
    } finally {
      statusRefreshInFlightRef.current = false;
    }
  }, [handleSessionStatus]);

  const sessionStream = useSessionStream({
    onError: setTerminalError,
    onOutput: handleActivityOutput,
    onStatus: handleSessionStatus,
    selectedSessionId,
    sessionIds,
  });

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

  const runAction = useCallback(
    async (sessionId: string, action: "start" | "stop") => {
      setActionSessionId(sessionId);
      setSessionError(null);
      try {
        const startOptions =
          action === "start" && terminalSize
            ? {
                headers: jsonHeaders(),
                body: JSON.stringify(terminalSize),
              }
            : {};
        const data = await jsonRequest<StatusResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
          { method: "POST", ...startOptions },
        );
        handleSessionStatus(data.status);
      } catch (requestError) {
        setSessionError(
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
      setSessionError(null);
      const data = await jsonRequest<SessionResponse>("/api/sessions", {
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
      setSessionError(null);
      const data = await jsonRequest<SessionResponse>(
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
      setSessionError(null);
      await jsonRequest<SessionResponse>(
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

  const updatePrompts = useCallback(
    async (nextPrompts: PromptsResponse["prompts"]) => {
      setPromptError(null);
      const data = await jsonRequest<PromptsResponse>("/api/prompts", {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ prompts: nextPrompts }),
      });
      setPrompts(data.prompts);
      return data.prompts;
    },
    [],
  );

  const requestTerminalInput = useCallback((data: string) => {
    terminalInputRequestIdRef.current += 1;
    setTerminalInputRequest({
      id: terminalInputRequestIdRef.current,
      data,
    });
  }, []);

  return {
    actionSessionId,
    createSession,
    deleteSession,
    handleActivityOutput,
    handleSessionStatus,
    loadSessions,
    loading,
    outputActivities,
    prompts,
    promptsLoaded,
    requestTerminalInput,
    runAction,
    selectedSession,
    selectedSessionId,
    selectedStatus,
    selectSession,
    sessionError,
    setTerminalError,
    setTerminalSize,
    streamConnectionState: sessionStream.connectionState,
    sessions,
    statuses,
    terminalOutput: sessionStream.terminalOutput,
    terminalInputRequest,
    terminalError,
    terminalSnapshot: sessionStream.terminalSnapshot,
    promptError,
    sendTerminalInput: sessionStream.sendInput,
    sendTerminalResize: sessionStream.sendResize,
    updatePrompts,
    updateSession,
  };
}
