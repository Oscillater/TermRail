import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "../api";
import type {
  RuntimeStatus,
  StreamConnectionState,
  TerminalSnapshotRequestOptions,
  TerminalSize,
  TerminalTarget,
  WsServerMessage,
} from "../types";
import type { TerminalStream } from "../terminalStream";

type UseSessionStreamOptions = {
  activeTerminal: TerminalTarget | null;
  onConfigStale: () => void;
  onError: (message: string | null) => void;
  onOutput: (
    sessionId: string,
    terminalId: string,
    outputAtIso?: string,
  ) => void;
  onSessionStatus: (status: RuntimeStatus) => void;
  onTerminalStatus: (status: RuntimeStatus) => void;
  terminalStream: TerminalStream;
  terminalTargets: TerminalTarget[];
};

type JsonClientMessage =
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
      mode?: TerminalSnapshotRequestOptions["mode"];
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

function targetKey(target: TerminalTarget): string {
  return `${target.sessionId}\u0000${target.terminalId}`;
}

function sameTarget(
  left: TerminalTarget | null,
  right: TerminalTarget | null,
): boolean {
  return (
    left?.sessionId === right?.sessionId &&
    left?.terminalId === right?.terminalId
  );
}

type LatestSeqState = {
  runtimeId: number | null;
  seq: number;
};

function shouldAcceptSeq(
  latest: LatestSeqState | undefined,
  runtimeId: number | null,
  seq: number,
): boolean {
  return !latest || latest.runtimeId !== runtimeId || seq > latest.seq;
}

export function useSessionStream({
  activeTerminal,
  onConfigStale,
  onError,
  onOutput,
  onSessionStatus,
  onTerminalStatus,
  terminalStream,
  terminalTargets,
}: UseSessionStreamOptions) {
  const [connectionState, setConnectionState] =
    useState<StreamConnectionState>("idle");
  const activeTerminalRef = useRef<TerminalTarget | null>(activeTerminal);
  const latestSeqByTerminalRef = useRef<Record<string, LatestSeqState>>({});
  const pendingSnapshotRequestsRef = useRef<Record<string, string>>({});
  const snapshotRequestCounterRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  const terminalTargetsKey = useMemo(
    () => JSON.stringify(terminalTargets),
    [terminalTargets],
  );

  useEffect(() => {
    activeTerminalRef.current = activeTerminal;
  }, [activeTerminal]);

  const sendJson = useCallback((message: JsonClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const syncLatestSeqRuntime = useCallback((status: RuntimeStatus) => {
    const terminalId = status.terminalId;
    if (!terminalId) {
      return;
    }

    const key = targetKey({ sessionId: status.sessionId, terminalId });
    if (latestSeqByTerminalRef.current[key]?.runtimeId === status.runtimeId) {
      return;
    }

    latestSeqByTerminalRef.current = {
      ...latestSeqByTerminalRef.current,
      [key]: { runtimeId: status.runtimeId, seq: 0 },
    };
  }, []);

  const sendSnapshotRequest = useCallback(
    (
      socket: WebSocket,
      target: TerminalTarget,
      size: TerminalSize,
      options: TerminalSnapshotRequestOptions = {},
    ): boolean => {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      snapshotRequestCounterRef.current += 1;
      const requestId = `${Date.now()}:${snapshotRequestCounterRef.current}`;
      const key = targetKey(target);
      const latestSeq = latestSeqByTerminalRef.current[key]?.seq ?? 0;
      const minSeq = options.minSeq ?? (latestSeq > 0 ? latestSeq : undefined);
      pendingSnapshotRequestsRef.current[key] = requestId;
      socket.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: target.sessionId,
          terminalId: target.terminalId,
          requestId,
          cols: size.cols,
          rows: size.rows,
          mode: options.mode ?? "tail",
          minSeq,
        } satisfies JsonClientMessage),
      );
      return true;
    },
    [],
  );

  const requestSnapshot = useCallback(
    (
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
      options?: TerminalSnapshotRequestOptions,
    ): boolean => {
      const socket = socketRef.current;
      if (!socket) {
        return false;
      }
      return sendSnapshotRequest(
        socket,
        { sessionId, terminalId },
        { cols, rows },
        options,
      );
    },
    [sendSnapshotRequest],
  );

  const sendInput = useCallback(
    (sessionId: string, terminalId: string, data: string): boolean =>
      sendJson({ type: "input", sessionId, terminalId, data }),
    [sendJson],
  );

  const sendResize = useCallback(
    (
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): boolean =>
      sendJson({ type: "resize", sessionId, terminalId, cols, rows }),
    [sendJson],
  );

  useEffect(() => {
    const parsedTargets = JSON.parse(terminalTargetsKey) as TerminalTarget[];
    const activeKeys = new Set(parsedTargets.map(targetKey));
    latestSeqByTerminalRef.current = Object.fromEntries(
      Object.entries(latestSeqByTerminalRef.current).filter(([key]) =>
        activeKeys.has(key),
      ),
    );
    pendingSnapshotRequestsRef.current = Object.fromEntries(
      Object.entries(pendingSnapshotRequestsRef.current).filter(([key]) =>
        activeKeys.has(key),
      ),
    );

    if (parsedTargets.length === 0) {
      setConnectionState("idle");
      latestSeqByTerminalRef.current = {};
      pendingSnapshotRequestsRef.current = {};
      return undefined;
    }

    let closed = false;
    let reconnectTimerId: number | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      setConnectionState("connecting");
      const nextSocket = new WebSocket(wsUrl());
      socket = nextSocket;
      socketRef.current = nextSocket;

      nextSocket.addEventListener("open", () => {
        if (closed || socket !== nextSocket) {
          return;
        }

        latestSeqByTerminalRef.current = {};
        pendingSnapshotRequestsRef.current = {};
        setConnectionState("connected");
        onError(null);

        parsedTargets.forEach((target) => {
          nextSocket.send(
            JSON.stringify({
              type: "subscribe",
              sessionId: target.sessionId,
              terminalId: target.terminalId,
            } satisfies JsonClientMessage),
          );
        });
      });

      nextSocket.addEventListener("message", (event) => {
        if (closed || socket !== nextSocket) {
          return;
        }

        let message: WsServerMessage;
        try {
          message = JSON.parse(String(event.data)) as WsServerMessage;
        } catch {
          return;
        }

        switch (message.type) {
          case "subscribed":
            syncLatestSeqRuntime(message.status);
            onTerminalStatus(message.status);
            break;
          case "terminal.snapshot": {
            const snapshotTarget = {
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            };
            const key = targetKey(snapshotTarget);
            if (pendingSnapshotRequestsRef.current[key] !== message.requestId) {
              break;
            }

            delete pendingSnapshotRequestsRef.current[key];
            if (
              message.complete &&
              shouldAcceptSeq(
                latestSeqByTerminalRef.current[key],
                message.runtimeId,
                message.seq,
              )
            ) {
              latestSeqByTerminalRef.current = {
                ...latestSeqByTerminalRef.current,
                [key]: { runtimeId: message.runtimeId, seq: message.seq },
              };
            }
            onTerminalStatus(message.status);

            if (sameTarget(snapshotTarget, activeTerminalRef.current)) {
              terminalStream.publish({
                type: "snapshot",
                sessionId: message.sessionId,
                terminalId: message.terminalId,
                runtimeId: message.runtimeId,
                format: message.format,
                mode: message.mode,
                data: message.data,
                seq: message.seq,
                minSeq: message.minSeq,
                complete: message.complete,
                cols: message.cols,
                rows: message.rows,
                screenRevision: message.screenRevision,
                bufferType: message.bufferType,
              });
            }
            break;
          }
          case "terminal.screen-progress": {
            const progressTarget = {
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            };
            if (sameTarget(progressTarget, activeTerminalRef.current)) {
              terminalStream.publish({
                type: "progress",
                sessionId: message.sessionId,
                terminalId: message.terminalId,
                runtimeId: message.runtimeId,
                seq: message.seq,
                screenRevision: message.screenRevision,
                bufferType: message.bufferType,
                cols: message.cols,
                rows: message.rows,
              });
            }
            break;
          }
          case "terminal.output": {
            const outputTarget = {
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            };
            const key = targetKey(outputTarget);
            const latestSeq = latestSeqByTerminalRef.current[key];
            if (!shouldAcceptSeq(latestSeq, message.runtimeId, message.seq)) {
              break;
            }

            onOutput(message.sessionId, message.terminalId, message.at);

            latestSeqByTerminalRef.current = {
              ...latestSeqByTerminalRef.current,
              [key]: { runtimeId: message.runtimeId, seq: message.seq },
            };

            if (sameTarget(outputTarget, activeTerminalRef.current)) {
              terminalStream.publish({
                type: "output",
                sessionId: message.sessionId,
                terminalId: message.terminalId,
                runtimeId: message.runtimeId,
                data: message.data,
                at: message.at,
                seq: message.seq,
              });
            }
            break;
          }
          case "terminal.status":
            syncLatestSeqRuntime(message.status);
            onTerminalStatus(message.status);
            break;
          case "session.status":
            onSessionStatus(message.status);
            break;
          case "error":
            onError(message.error.message);
            if (
              message.error.code === "TERMINAL_NOT_FOUND" ||
              message.error.code === "SESSION_NOT_FOUND"
            ) {
              onConfigStale();
            }
            break;
          case "unsubscribed":
            break;
        }
      });

      nextSocket.addEventListener("close", () => {
        if (closed || socket !== nextSocket) {
          return;
        }
        setConnectionState("closed");
        reconnectTimerId = window.setTimeout(connect, 1_000);
      });

      nextSocket.addEventListener("error", () => {
        onError("WebSocket connection failed");
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
        parsedTargets.forEach((target) => {
          socket?.send(
            JSON.stringify({
              type: "unsubscribe",
              sessionId: target.sessionId,
              terminalId: target.terminalId,
            } satisfies JsonClientMessage),
          );
        });
      }
      socket?.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [
    onError,
    onConfigStale,
    onOutput,
    onSessionStatus,
    onTerminalStatus,
    sendSnapshotRequest,
    syncLatestSeqRuntime,
    terminalStream,
    terminalTargetsKey,
  ]);

  return {
    connectionState,
    requestSnapshot,
    sendInput,
    sendResize,
  };
}
