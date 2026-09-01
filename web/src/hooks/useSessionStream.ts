import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "../api";
import type {
  RuntimeStatus,
  StreamConnectionState,
  TerminalTarget,
  WsServerMessage,
} from "../types";
import type { TerminalStream } from "../terminalStream";

type UseSessionStreamOptions = {
  activeTerminal: TerminalTarget | null;
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
      includeBuffer: boolean;
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

export function useSessionStream({
  activeTerminal,
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
  const latestSeqByTerminalRef = useRef<Record<string, number>>({});
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

    if (parsedTargets.length === 0) {
      setConnectionState("idle");
      latestSeqByTerminalRef.current = {};
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
        setConnectionState("connected");
        onError(null);
        parsedTargets.forEach((target) => {
          const includeBuffer = sameTarget(target, activeTerminalRef.current);
          if (includeBuffer) {
            terminalStream.clearSnapshot(target);
          }
          nextSocket.send(
            JSON.stringify({
              type: "subscribe",
              sessionId: target.sessionId,
              terminalId: target.terminalId,
              includeBuffer,
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
            onTerminalStatus(message.status);
            const subscribedTarget = {
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            };
            if (sameTarget(subscribedTarget, activeTerminalRef.current)) {
              terminalStream.publish({
                type: "snapshot",
                sessionId: message.sessionId,
                terminalId: message.terminalId,
                buffer: message.buffer,
              });
            }
            break;
          case "terminal.output": {
            const key = targetKey({
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            });
            if (typeof message.seq === "number") {
              const latestSeq = latestSeqByTerminalRef.current[key];
              if (latestSeq !== undefined && message.seq <= latestSeq) {
                break;
              }
              latestSeqByTerminalRef.current = {
                ...latestSeqByTerminalRef.current,
                [key]: message.seq,
              };
            }

            onOutput(message.sessionId, message.terminalId, message.at);
            const outputTarget = {
              sessionId: message.sessionId,
              terminalId: message.terminalId,
            };
            if (sameTarget(outputTarget, activeTerminalRef.current)) {
              terminalStream.publish({
                type: "output",
                sessionId: message.sessionId,
                terminalId: message.terminalId,
                data: message.data,
                at: message.at ?? new Date().toISOString(),
                seq: message.seq ?? 0,
              });
            }
            break;
          }
          case "terminal.status":
            onTerminalStatus(message.status);
            break;
          case "session.status":
            onSessionStatus(message.status);
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
        parsedTargets.forEach((target) => {
          socket?.send(
            JSON.stringify({
              type: "unsubscribe",
              sessionId: target.sessionId,
              terminalId: target.terminalId,
            }),
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
    onOutput,
    onSessionStatus,
    onTerminalStatus,
    terminalStream,
    terminalTargetsKey,
  ]);

  useEffect(() => {
    if (!activeTerminal) {
      return;
    }

    const parsedTargets = JSON.parse(terminalTargetsKey) as TerminalTarget[];
    if (!parsedTargets.some((target) => sameTarget(target, activeTerminal))) {
      return;
    }

    terminalStream.clearSnapshot(activeTerminal);
    sendJson({
      type: "subscribe",
      sessionId: activeTerminal.sessionId,
      terminalId: activeTerminal.terminalId,
      includeBuffer: true,
    });
  }, [activeTerminal, sendJson, terminalStream, terminalTargetsKey]);

  return {
    connectionState,
    sendInput,
    sendResize,
  };
}
