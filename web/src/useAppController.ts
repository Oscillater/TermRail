import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsonHeaders, jsonRequest } from "./api";
import { useSessionStream } from "./hooks/useSessionStream";
import { createTerminalStream } from "./terminalStream";
import type {
  PromptsResponse,
  RuntimeStatus,
  SessionAttentionById,
  SessionConfig,
  SessionResponse,
  SessionsResponse,
  StatusesResponse,
  StatusResponse,
  TerminalAttentionBySession,
  TerminalConfig,
  TerminalInputRequest,
  TerminalSnapshotRequestOptions,
  TerminalResponse,
  TerminalSize,
  TerminalTarget,
} from "./types";
import {
  aggregateSessionStatus,
  collectSessionAttention,
  collectSessionPrompts,
  collectTerminalAttention,
  defaultRuntimeStatus,
  mergeRuntimeStatus,
  statusRefreshIntervalMs,
  terminalAttentionKey,
  timestampFromIso,
} from "./utils/activity";

type TerminalStatusesBySession = Record<string, Record<string, RuntimeStatus>>;
type ActiveTerminalIds = Record<string, string | null>;
type TerminalReadAt = Record<string, number>;
type PendingActivityOutput = {
  sessionId: string;
  terminalId: string;
  outputAtIso?: string;
  receivedAt: number;
};

const activityOutputFlushMs = 100;
const terminalReadAtStorageKey = "termrail:terminal-read-at:v1";

function actionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function readTerminalReadAt(): TerminalReadAt {
  try {
    const raw = window.localStorage.getItem(terminalReadAtStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" &&
          Number.isFinite(entry[1]) &&
          entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function writeTerminalReadAt(readAt: TerminalReadAt): void {
  try {
    window.localStorage.setItem(
      terminalReadAtStorageKey,
      JSON.stringify(readAt),
    );
  } catch {
    // Read receipts are a UI convenience and can be rebuilt from live status.
  }
}

function pruneTerminalReadAt(
  current: TerminalReadAt,
  sessions: SessionConfig[],
): TerminalReadAt {
  const validKeys = new Set(
    sessions.flatMap((session) =>
      session.terminals.map((terminal) =>
        terminalAttentionKey(session.id, terminal.id),
      ),
    ),
  );
  let changed = false;
  const next: TerminalReadAt = {};

  Object.entries(current).forEach(([key, value]) => {
    if (validKeys.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  });

  return changed ? next : current;
}

function removeTerminalReadAt(
  current: TerminalReadAt,
  predicate: (key: string) => boolean,
): TerminalReadAt {
  let changed = false;
  const next: TerminalReadAt = {};

  Object.entries(current).forEach(([key, value]) => {
    if (predicate(key)) {
      changed = true;
      return;
    }
    next[key] = value;
  });

  return changed ? next : current;
}

function terminalStatusReadTime(status: RuntimeStatus): number {
  return Math.max(
    Date.now(),
    timestampFromIso(status.lastOutputAt) ?? 0,
    timestampFromIso(status.stoppedAt) ?? 0,
    timestampFromIso(status.startedAt) ?? 0,
  );
}

function documentVisible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

function syncActiveTerminalIds(
  current: ActiveTerminalIds,
  sessions: SessionConfig[],
): ActiveTerminalIds {
  const next: ActiveTerminalIds = {};
  sessions.forEach((session) => {
    const currentTerminalId = current[session.id] ?? null;
    next[session.id] = session.terminals.some(
      (terminal) => terminal.id === currentTerminalId,
    )
      ? currentTerminalId
      : (session.terminals[0]?.id ?? null);
  });
  return next;
}

function nextActiveTerminalIdAfterDelete(
  previousTerminals: TerminalConfig[],
  remainingTerminals: TerminalConfig[],
  deletedTerminalId: string,
  currentTerminalId: string | null,
): string | null {
  if (
    currentTerminalId &&
    currentTerminalId !== deletedTerminalId &&
    remainingTerminals.some((terminal) => terminal.id === currentTerminalId)
  ) {
    return currentTerminalId;
  }

  const deletedIndex = previousTerminals.findIndex(
    (terminal) => terminal.id === deletedTerminalId,
  );
  const candidates =
    deletedIndex === -1
      ? []
      : [
          previousTerminals[deletedIndex + 1]?.id,
          previousTerminals[deletedIndex - 1]?.id,
        ];
  const adjacentTerminalId = candidates.find(
    (terminalId): terminalId is string =>
      Boolean(terminalId) &&
      remainingTerminals.some((terminal) => terminal.id === terminalId),
  );

  return adjacentTerminalId ?? remainingTerminals[0]?.id ?? null;
}

function normalizeTerminalStatuses(
  sessions: SessionConfig[],
  statuses: TerminalStatusesBySession | undefined,
): TerminalStatusesBySession {
  return Object.fromEntries(
    sessions.map((session) => {
      const current = statuses?.[session.id] ?? {};
      return [
        session.id,
        Object.fromEntries(
          session.terminals.map((terminal) => [
            terminal.id,
            current[terminal.id] ??
              defaultRuntimeStatus(session.id, terminal.id),
          ]),
        ),
      ];
    }),
  );
}

function aggregateStatuses(
  sessions: SessionConfig[],
  terminalStatuses: TerminalStatusesBySession,
): Record<string, RuntimeStatus> {
  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      aggregateSessionStatus(session, terminalStatuses[session.id]),
    ]),
  );
}

export function useAppController() {
  const [prompts, setPrompts] = useState<PromptsResponse["prompts"]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({});
  const [terminalStatuses, setTerminalStatuses] =
    useState<TerminalStatusesBySession>({});
  const [activeTerminalIds, setActiveTerminalIds] = useState<ActiveTerminalIds>(
    {},
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [terminalReadAt, setTerminalReadAt] =
    useState<TerminalReadAt>(readTerminalReadAt);
  const [activityNow, setActivityNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [actionTerminalKey, setActionTerminalKey] = useState<string | null>(
    null,
  );
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [terminalInputRequest, setTerminalInputRequest] =
    useState<TerminalInputRequest | null>(null);
  const [terminalSize, setTerminalSize] = useState<TerminalSize | null>(null);
  const sessionsRef = useRef<SessionConfig[]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);
  const statusesRef = useRef<Record<string, RuntimeStatus>>({});
  const terminalStatusesRef = useRef<TerminalStatusesBySession>({});
  const activeTerminalIdsRef = useRef<ActiveTerminalIds>({});
  const statusRefreshInFlightRef = useRef(false);
  const activityOutputFlushTimerRef = useRef<number | null>(null);
  const pendingActivityOutputsRef = useRef<
    Record<string, PendingActivityOutput>
  >({});
  const terminalInputRequestIdRef = useRef(0);
  const terminalStream = useMemo(() => createTerminalStream(), []);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedStatus = selectedSessionId
    ? statuses[selectedSessionId]
    : undefined;
  const selectedTerminalId = selectedSessionId
    ? (activeTerminalIds[selectedSessionId] ?? null)
    : null;
  const selectedTerminal = selectedSession
    ? (selectedSession.terminals.find(
        (terminal) => terminal.id === selectedTerminalId,
      ) ?? null)
    : null;
  const selectedTerminalStatuses = selectedSessionId
    ? (terminalStatuses[selectedSessionId] ?? {})
    : {};
  const selectedTerminalStatus =
    selectedSession && selectedTerminal
      ? (selectedTerminalStatuses[selectedTerminal.id] ??
        defaultRuntimeStatus(selectedSession.id, selectedTerminal.id))
      : undefined;

  const terminalTargets = useMemo<TerminalTarget[]>(
    () =>
      sessions.flatMap((session) =>
        session.terminals.map((terminal) => ({
          sessionId: session.id,
          terminalId: terminal.id,
        })),
      ),
    [sessions],
  );
  const activeTerminal = useMemo<TerminalTarget | null>(
    () =>
      selectedSessionId && selectedTerminalId
        ? { sessionId: selectedSessionId, terminalId: selectedTerminalId }
        : null,
    [selectedSessionId, selectedTerminalId],
  );

  const terminalAttention = useMemo<TerminalAttentionBySession>(
    () =>
      collectTerminalAttention(
        sessions,
        terminalStatuses,
        terminalReadAt,
        activityNow,
      ),
    [activityNow, sessions, terminalReadAt, terminalStatuses],
  );
  const sessionAttention = useMemo<SessionAttentionById>(
    () => collectSessionAttention(sessions, terminalAttention),
    [sessions, terminalAttention],
  );
  const selectedTerminalAttention = selectedSessionId
    ? (terminalAttention[selectedSessionId] ?? {})
    : {};

  useEffect(() => {
    writeTerminalReadAt(terminalReadAt);
  }, [terminalReadAt]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    activeTerminalIdsRef.current = activeTerminalIds;
  }, [activeTerminalIds]);

  const markTerminalReadAt = useCallback(
    (sessionId: string, terminalId: string, readAt = Date.now()) => {
      const key = terminalAttentionKey(sessionId, terminalId);
      setTerminalReadAt((current) => {
        if ((current[key] ?? 0) >= readAt) {
          return current;
        }

        const next = { ...current, [key]: readAt };
        return next;
      });
    },
    [],
  );

  const markVisibleTerminalReadAt = useCallback(
    (sessionId: string, terminalId: string, readAt = Date.now()) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const activeTerminalId =
        activeTerminalIdsRef.current[sessionId] ??
        session?.terminals[0]?.id ??
        null;

      if (
        documentVisible() &&
        selectedSessionIdRef.current === sessionId &&
        activeTerminalId === terminalId
      ) {
        markTerminalReadAt(sessionId, terminalId, readAt);
      }
    },
    [markTerminalReadAt],
  );

  const updateSessionStatus = useCallback((status: RuntimeStatus) => {
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

  const recomputeSessionStatus = useCallback(
    (
      sessionId: string,
      nextTerminalStatuses: Record<string, RuntimeStatus>,
    ) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) {
        return;
      }

      const status = aggregateSessionStatus(session, nextTerminalStatuses);
      statusesRef.current = {
        ...statusesRef.current,
        [sessionId]: status,
      };
      setStatuses((current) => ({ ...current, [sessionId]: status }));
    },
    [],
  );

  const updateTerminalStatus = useCallback(
    (status: RuntimeStatus) => {
      const terminalId = status.terminalId;
      if (!terminalId) {
        return;
      }

      setTerminalStatuses((current) => {
        const sessionStatuses = current[status.sessionId] ?? {};
        const mergedStatus = mergeRuntimeStatus(
          sessionStatuses[terminalId],
          status,
        );
        const nextSessionStatuses = {
          ...sessionStatuses,
          [terminalId]: mergedStatus,
        };
        const next = {
          ...current,
          [status.sessionId]: nextSessionStatuses,
        };
        terminalStatusesRef.current = next;
        recomputeSessionStatus(status.sessionId, nextSessionStatuses);
        return next;
      });
    },
    [recomputeSessionStatus],
  );

  const handleTerminalStatus = useCallback(
    (status: RuntimeStatus) => {
      updateTerminalStatus(status);
    },
    [updateTerminalStatus],
  );

  const selectSession = useCallback((sessionId: string) => {
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
  }, []);

  const selectTerminal = useCallback(
    (sessionId: string, terminalId: string) => {
      selectedSessionIdRef.current = sessionId;
      activeTerminalIdsRef.current = {
        ...activeTerminalIdsRef.current,
        [sessionId]: terminalId,
      };
      setActiveTerminalIds((current) => ({
        ...current,
        [sessionId]: terminalId,
      }));
      setSelectedSessionId(sessionId);
    },
    [],
  );

  const upsertSession = useCallback(
    (session: SessionConfig) => {
      setSessions((current) => {
        const existingIndex = current.findIndex(
          (item) => item.id === session.id,
        );
        const nextSessions =
          existingIndex === -1
            ? [...current, session]
            : current.map((item) => (item.id === session.id ? session : item));
        sessionsRef.current = nextSessions;
        return nextSessions;
      });

      setTerminalStatuses((current) => {
        const next = normalizeTerminalStatuses([session], {
          [session.id]: current[session.id] ?? {},
        });
        const allStatuses = {
          ...current,
          [session.id]: next[session.id] ?? {},
        };
        terminalStatusesRef.current = allStatuses;
        recomputeSessionStatus(session.id, allStatuses[session.id] ?? {});
        return allStatuses;
      });
    },
    [recomputeSessionStatus],
  );

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setSessionError(null);
    try {
      const data = await jsonRequest<SessionsResponse>("/api/sessions");
      const nextTerminalStatuses = normalizeTerminalStatuses(
        data.sessions,
        data.terminalStatuses,
      );
      const nextStatuses =
        data.statuses ?? aggregateStatuses(data.sessions, nextTerminalStatuses);
      setPrompts(data.prompts ?? collectSessionPrompts(data.sessions));
      setPromptsLoaded(true);
      sessionsRef.current = data.sessions;
      statusesRef.current = nextStatuses;
      terminalStatusesRef.current = nextTerminalStatuses;
      setSessions(data.sessions);
      setStatuses(nextStatuses);
      setTerminalStatuses(nextTerminalStatuses);
      setActivityNow(Date.now());
      setActiveTerminalIds((current) =>
        syncActiveTerminalIds(current, data.sessions),
      );
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
    sessionsRef.current = sessions;
    setTerminalReadAt((current) => {
      return pruneTerminalReadAt(current, sessions);
    });
    setActiveTerminalIds((current) => syncActiveTerminalIds(current, sessions));
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

  const flushActivityOutputs = useCallback(() => {
    const pending = Object.values(pendingActivityOutputsRef.current);
    pendingActivityOutputsRef.current = {};
    activityOutputFlushTimerRef.current = null;
    if (pending.length === 0) {
      return;
    }

    let latestReceivedAt = 0;
    pending.forEach(({ sessionId, terminalId, outputAtIso, receivedAt }) => {
      if (!sessionsRef.current.some((session) => session.id === sessionId)) {
        return;
      }

      const outputAt = timestampFromIso(outputAtIso ?? null) ?? receivedAt;
      const previousStatus =
        terminalStatusesRef.current[sessionId]?.[terminalId] ??
        defaultRuntimeStatus(sessionId, terminalId);

      updateTerminalStatus({
        ...previousStatus,
        sessionId,
        terminalId,
        state: "running",
        stoppedAt: null,
        exitCode: null,
        lastOutputAt: new Date(outputAt).toISOString(),
      });
      latestReceivedAt = Math.max(latestReceivedAt, receivedAt);
    });

    if (latestReceivedAt > 0) {
      setActivityNow(latestReceivedAt);
    }
  }, [updateTerminalStatus]);

  const handleActivityOutput = useCallback(
    (sessionId: string, terminalId: string, outputAtIso?: string) => {
      if (!sessionsRef.current.some((session) => session.id === sessionId)) {
        return;
      }

      pendingActivityOutputsRef.current[actionKey(sessionId, terminalId)] = {
        sessionId,
        terminalId,
        outputAtIso,
        receivedAt: Date.now(),
      };
      if (activityOutputFlushTimerRef.current !== null) {
        return;
      }

      activityOutputFlushTimerRef.current = window.setTimeout(
        flushActivityOutputs,
        activityOutputFlushMs,
      );
    },
    [flushActivityOutputs],
  );

  useEffect(() => {
    return () => {
      if (activityOutputFlushTimerRef.current !== null) {
        window.clearTimeout(activityOutputFlushTimerRef.current);
      }
      pendingActivityOutputsRef.current = {};
    };
  }, []);

  const refreshStatuses = useCallback(async () => {
    if (statusRefreshInFlightRef.current || sessionsRef.current.length === 0) {
      return;
    }

    statusRefreshInFlightRef.current = true;
    try {
      const data = await jsonRequest<StatusesResponse>("/api/status");
      const nextTerminalStatuses = normalizeTerminalStatuses(
        sessionsRef.current,
        data.terminalStatuses,
      );
      const nextStatuses =
        data.statuses ??
        aggregateStatuses(sessionsRef.current, nextTerminalStatuses);
      statusesRef.current = nextStatuses;
      terminalStatusesRef.current = nextTerminalStatuses;
      setStatuses(nextStatuses);
      setTerminalStatuses(nextTerminalStatuses);
      setActivityNow(Date.now());
    } catch {
      // The WebSocket is still the primary live channel; polling is best-effort.
    } finally {
      statusRefreshInFlightRef.current = false;
    }
  }, []);

  const reloadSessionsForStreamError = useCallback(() => {
    void loadSessions();
  }, [loadSessions]);

  const sessionStream = useSessionStream({
    activeTerminal,
    onConfigStale: reloadSessionsForStreamError,
    onError: setTerminalError,
    onOutput: handleActivityOutput,
    onSessionStatus: updateSessionStatus,
    onTerminalStatus: handleTerminalStatus,
    terminalStream,
    terminalTargets,
  });

  const sendTerminalInput = useCallback(
    (sessionId: string, terminalId: string, data: string): boolean => {
      const sent = sessionStream.sendInput(sessionId, terminalId, data);
      if (sent) {
        markTerminalReadAt(sessionId, terminalId);
      }
      return sent;
    },
    [markTerminalReadAt, sessionStream.sendInput],
  );

  const requestTerminalSnapshot = useCallback(
    (
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
      options?: TerminalSnapshotRequestOptions,
    ): boolean =>
      sessionStream.requestSnapshot(sessionId, terminalId, cols, rows, options),
    [sessionStream.requestSnapshot],
  );

  const markVisibleTerminalOutputApplied = useCallback(
    (sessionId: string, terminalId: string) => {
      markVisibleTerminalReadAt(sessionId, terminalId);
    },
    [markVisibleTerminalReadAt],
  );

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

  const runTerminalAction = useCallback(
    async (sessionId: string, terminalId: string, action: "start" | "stop") => {
      setActionTerminalKey(actionKey(sessionId, terminalId));
      setTerminalError(null);
      try {
        const startOptions =
          action === "start" && terminalSize
            ? {
                headers: jsonHeaders(),
                body: JSON.stringify(terminalSize),
              }
            : {};
        const data = await jsonRequest<StatusResponse>(
          `/api/sessions/${encodeURIComponent(
            sessionId,
          )}/terminals/${encodeURIComponent(terminalId)}/${action}`,
          { method: "POST", ...startOptions },
        );
        updateTerminalStatus(data.status);
        if (action === "stop") {
          markTerminalReadAt(
            sessionId,
            terminalId,
            terminalStatusReadTime(data.status),
          );
        }
        if (data.sessionStatus) {
          updateSessionStatus(data.sessionStatus);
        }
      } catch (requestError) {
        setTerminalError(
          requestError instanceof Error
            ? requestError.message
            : `Failed to ${action} terminal`,
        );
      } finally {
        setActionTerminalKey(null);
      }
    },
    [
      markTerminalReadAt,
      terminalSize,
      updateSessionStatus,
      updateTerminalStatus,
    ],
  );

  const createSession = useCallback(
    async (session: Omit<SessionConfig, "terminals">) => {
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
    async (sessionId: string, session: Omit<SessionConfig, "terminals">) => {
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

  const createTerminal = useCallback(
    async (
      sessionId: string,
      terminal: Pick<TerminalConfig, "name" | "command">,
    ) => {
      setTerminalError(null);
      const body = terminalSize ? { ...terminal, ...terminalSize } : terminal;
      const data = await jsonRequest<TerminalResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/terminals`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        },
      );
      upsertSession(data.session);
      selectedSessionIdRef.current = sessionId;
      activeTerminalIdsRef.current = {
        ...activeTerminalIdsRef.current,
        [sessionId]: data.terminal.id,
      };
      setActiveTerminalIds((current) => ({
        ...current,
        [sessionId]: data.terminal.id,
      }));
      setSelectedSessionId(sessionId);
      markTerminalReadAt(sessionId, data.terminal.id);
      if (data.status) {
        updateTerminalStatus(data.status);
      }
      if (data.sessionStatus) {
        updateSessionStatus(data.sessionStatus);
      }
      return data.terminal;
    },
    [
      markTerminalReadAt,
      terminalSize,
      updateSessionStatus,
      updateTerminalStatus,
      upsertSession,
    ],
  );

  const updateTerminal = useCallback(
    async (
      sessionId: string,
      terminalId: string,
      terminal: Pick<TerminalConfig, "name" | "command">,
    ) => {
      setTerminalError(null);
      const data = await jsonRequest<TerminalResponse>(
        `/api/sessions/${encodeURIComponent(
          sessionId,
        )}/terminals/${encodeURIComponent(terminalId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify(terminal),
        },
      );
      upsertSession(data.session);
      if (data.status) {
        updateTerminalStatus(data.status);
      }
      if (data.sessionStatus) {
        updateSessionStatus(data.sessionStatus);
      }
      return data.terminal;
    },
    [updateSessionStatus, updateTerminalStatus, upsertSession],
  );

  const deleteTerminal = useCallback(
    async (sessionId: string, terminalId: string) => {
      setTerminalError(null);
      const previousSession = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const previousTerminals = previousSession?.terminals ?? [];
      const data = await jsonRequest<TerminalResponse>(
        `/api/sessions/${encodeURIComponent(
          sessionId,
        )}/terminals/${encodeURIComponent(terminalId)}`,
        { method: "DELETE" },
      );
      upsertSession(data.session);
      setTerminalStatuses((current) => {
        const nextSessionStatuses = { ...(current[sessionId] ?? {}) };
        delete nextSessionStatuses[terminalId];
        const next = { ...current, [sessionId]: nextSessionStatuses };
        terminalStatusesRef.current = next;
        return next;
      });
      setTerminalReadAt((current) => {
        const key = terminalAttentionKey(sessionId, terminalId);
        return removeTerminalReadAt(current, (itemKey) => itemKey === key);
      });
      setActiveTerminalIds((current) => ({
        ...current,
        [sessionId]: nextActiveTerminalIdAfterDelete(
          previousTerminals,
          data.session.terminals,
          terminalId,
          current[sessionId] ?? null,
        ),
      }));
      if (data.sessionStatus) {
        updateSessionStatus(data.sessionStatus);
      }
      return data.terminal;
    },
    [updateSessionStatus, upsertSession],
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
      sessionsRef.current = nextSessions;
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
      setTerminalStatuses((current) => {
        const next = { ...current };
        delete next[sessionId];
        delete terminalStatusesRef.current[sessionId];
        return next;
      });
      setTerminalReadAt((current) => {
        const prefix = `${sessionId}/`;
        return removeTerminalReadAt(current, (key) => key.startsWith(prefix));
      });
      setActiveTerminalIds((current) => {
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
    actionTerminalKey,
    activeTerminal,
    activeTerminalIds,
    createSession,
    createTerminal,
    deleteSession,
    deleteTerminal,
    loadSessions,
    loading,
    prompts,
    promptsLoaded,
    markVisibleTerminalOutputApplied,
    requestTerminalInput,
    requestTerminalSnapshot,
    runTerminalAction,
    selectedSession,
    selectedSessionId,
    selectedStatus,
    selectedTerminal,
    selectedTerminalId,
    selectedTerminalAttention,
    selectedTerminalStatus,
    selectedTerminalStatuses,
    selectSession,
    selectTerminal,
    sessionAttention,
    sessionError,
    setTerminalError,
    setTerminalSize,
    streamConnectionState: sessionStream.connectionState,
    sessions,
    statuses,
    terminalInputRequest,
    terminalError,
    promptError,
    sendTerminalInput,
    sendTerminalResize: sessionStream.sendResize,
    terminalAttention,
    terminalStatuses,
    terminalStream,
    updatePrompts,
    updateSession,
    updateTerminal,
  };
}
