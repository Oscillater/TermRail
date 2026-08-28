import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "../api";
import type {
  RuntimeStatus,
  StreamConnectionState,
  TerminalOutputDelivery,
  TerminalSessionSnapshot,
  WsServerMessage,
} from "../types";

type UseSessionStreamOptions = {
  onError: (message: string | null) => void;
  onOutput: (sessionId: string, outputAtIso?: string) => void;
  onStatus: (status: RuntimeStatus) => void;
  selectedSessionId: string | null;
  sessionIds: string[];
};

type JsonClientMessage =
  | { type: "subscribe"; sessionId: string; includeBuffer: boolean }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

export function useSessionStream({
  onError,
  onOutput,
  onStatus,
  selectedSessionId,
  sessionIds,
}: UseSessionStreamOptions) {
  const [connectionState, setConnectionState] =
    useState<StreamConnectionState>("idle");
  const [terminalOutput, setTerminalOutput] =
    useState<TerminalOutputDelivery | null>(null);
  const [terminalSnapshot, setTerminalSnapshot] =
    useState<TerminalSessionSnapshot | null>(null);
  const deliveryIdRef = useRef(0);
  const latestSeqBySessionRef = useRef<Record<string, number>>({});
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const socketRef = useRef<WebSocket | null>(null);

  const sessionIdsKey = useMemo(() => JSON.stringify(sessionIds), [sessionIds]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const sendJson = useCallback((message: JsonClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const sendInput = useCallback(
    (sessionId: string, data: string): boolean =>
      sendJson({ type: "input", sessionId, data }),
    [sendJson],
  );

  const sendResize = useCallback(
    (sessionId: string, cols: number, rows: number): boolean =>
      sendJson({ type: "resize", sessionId, cols, rows }),
    [sendJson],
  );

  useEffect(() => {
    const parsedSessionIds = JSON.parse(sessionIdsKey) as string[];
    const activeSessionIds = new Set(parsedSessionIds);
    latestSeqBySessionRef.current = Object.fromEntries(
      Object.entries(latestSeqBySessionRef.current).filter(([sessionId]) =>
        activeSessionIds.has(sessionId),
      ),
    );

    if (parsedSessionIds.length === 0) {
      setConnectionState("idle");
      latestSeqBySessionRef.current = {};
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
        latestSeqBySessionRef.current = {};
        setConnectionState("connected");
        onError(null);
        parsedSessionIds.forEach((sessionId) => {
          nextSocket.send(
            JSON.stringify({
              type: "subscribe",
              sessionId,
              includeBuffer: sessionId === selectedSessionIdRef.current,
            }),
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
            onStatus(message.status);
            if (message.sessionId === selectedSessionIdRef.current) {
              deliveryIdRef.current += 1;
              setTerminalSnapshot({
                id: deliveryIdRef.current,
                sessionId: message.sessionId,
                status: message.status,
                buffer: message.buffer,
              });
            }
            break;
          case "terminal.output": {
            if (typeof message.seq === "number") {
              const latestSeq =
                latestSeqBySessionRef.current[message.sessionId];
              if (latestSeq !== undefined && message.seq <= latestSeq) {
                break;
              }
              latestSeqBySessionRef.current = {
                ...latestSeqBySessionRef.current,
                [message.sessionId]: message.seq,
              };
            }

            onOutput(message.sessionId, message.at);
            if (message.sessionId === selectedSessionIdRef.current) {
              deliveryIdRef.current += 1;
              setTerminalOutput({
                deliveryId: deliveryIdRef.current,
                sessionId: message.sessionId,
                data: message.data,
                at: message.at ?? new Date().toISOString(),
                seq: message.seq ?? 0,
              });
            }
            break;
          }
          case "session.status":
            onStatus(message.status);
            break;
          case "error":
            onError(message.error.message);
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
        parsedSessionIds.forEach((sessionId) => {
          socket?.send(JSON.stringify({ type: "unsubscribe", sessionId }));
        });
      }
      socket?.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [onError, onOutput, onStatus, sessionIdsKey]);

  useEffect(() => {
    if (!selectedSessionId) {
      setTerminalOutput(null);
      setTerminalSnapshot(null);
      return;
    }

    const parsedSessionIds = JSON.parse(sessionIdsKey) as string[];
    if (!parsedSessionIds.includes(selectedSessionId)) {
      setTerminalOutput(null);
      setTerminalSnapshot(null);
      return;
    }

    sendJson({
      type: "subscribe",
      sessionId: selectedSessionId,
      includeBuffer: true,
    });
  }, [selectedSessionId, sendJson, sessionIdsKey]);

  return {
    connectionState,
    sendInput,
    sendResize,
    terminalOutput,
    terminalSnapshot,
  };
}
