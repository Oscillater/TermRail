import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import type {
  RuntimeStatus,
  SessionConfig,
  StreamConnectionState,
  TerminalInputRequest,
  TerminalOutputDelivery,
  TerminalSessionSnapshot,
  TerminalSize,
} from "../types";
import { formatDate, statusLabel } from "../utils/activity";
import { useTerminalClipboard } from "../hooks/useTerminalClipboard";
import { useTerminalScroll } from "../hooks/useTerminalScroll";
import { useTerminalWriter } from "../hooks/useTerminalWriter";
import { useXtermInstance } from "../hooks/useXtermInstance";
import { clampTerminalSize } from "../utils/terminal";

type TerminalPaneProps = {
  connectionState: StreamConnectionState;
  error: string | null;
  inputRequest: TerminalInputRequest | null;
  onError: (message: string | null) => void;
  onInput: (sessionId: string, data: string) => boolean;
  onResize: (sessionId: string, cols: number, rows: number) => boolean;
  onSize: (size: TerminalSize) => void;
  output: TerminalOutputDelivery | null;
  session: SessionConfig | null;
  snapshot: TerminalSessionSnapshot | null;
  status: RuntimeStatus | undefined;
};

export function TerminalPane({
  connectionState,
  error,
  inputRequest,
  onError,
  onInput,
  onResize,
  onSize,
  output,
  session,
  snapshot,
  status,
}: TerminalPaneProps) {
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef<RuntimeStatus | undefined>(status);
  const terminalRef = useRef<Terminal | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const connectionStateRef = useRef<StreamConnectionState>(connectionState);
  const {
    handleScrollKeyDown,
    handleScrollPointerDown,
    handleScrollPointerMove,
    handleScrollPointerUp,
    resetScrollState,
    scrollState,
    scrollTrackRef,
    updateTerminalScrollState,
  } = useTerminalScroll(terminalRef);
  const { copyTerminalSelection, pasteTerminalClipboard } =
    useTerminalClipboard(onError);
  const { cancelTerminalWrites, queueTerminalWrite, resetTerminalOutput } =
    useTerminalWriter(terminalRef, updateTerminalScrollState);

  const sendTerminalInput = useCallback(
    (data: string, reportErrors: boolean) => {
      const sessionId = activeSessionIdRef.current;

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

      if (connectionStateRef.current !== "connected") {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }

      if (!onInput(sessionId, data)) {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }
      terminalRef.current?.focus();
      return true;
    },
    [onError, onInput],
  );

  const publishTerminalSize = useCallback(
    (cols: number, rows: number) => {
      const size = clampTerminalSize(cols, rows);
      onSize(size);
      return size;
    },
    [onSize],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const sessionId = activeSessionIdRef.current;
      const size = clampTerminalSize(cols, rows);
      if (!sessionId || connectionStateRef.current !== "connected") {
        return;
      }

      if (
        lastResizeRef.current?.cols === size.cols &&
        lastResizeRef.current.rows === size.rows
      ) {
        return;
      }

      lastResizeRef.current = size;
      onResize(sessionId, size.cols, size.rows);
    },
    [onResize],
  );

  const handleTerminalReady = useCallback(
    (terminal: Terminal) => {
      publishTerminalSize(terminal.cols, terminal.rows);
      sendResize(terminal.cols, terminal.rows);
      updateTerminalScrollState(terminal);
    },
    [publishTerminalSize, sendResize, updateTerminalScrollState],
  );

  const handleTerminalResize = useCallback(
    (terminal: Terminal, cols: number, rows: number) => {
      publishTerminalSize(cols, rows);
      sendResize(cols, rows);
      updateTerminalScrollState(terminal);
    },
    [publishTerminalSize, sendResize, updateTerminalScrollState],
  );

  const handleTerminalDispose = useCallback(() => {
    cancelTerminalWrites();
    resetScrollState();
  }, [cancelTerminalWrites, resetScrollState]);

  const handleTerminalData = useCallback(
    (data: string) => {
      sendTerminalInput(data, false);
    },
    [sendTerminalInput],
  );

  const handleCopyShortcut = useCallback(
    (terminal: Terminal) => {
      void copyTerminalSelection(terminal);
    },
    [copyTerminalSelection],
  );

  const handlePasteShortcut = useCallback(
    (terminal: Terminal) => {
      void pasteTerminalClipboard(terminal);
    },
    [pasteTerminalClipboard],
  );

  const { containerRef, fitTerminal } = useXtermInstance(terminalRef, {
    onCopyShortcut: handleCopyShortcut,
    onData: handleTerminalData,
    onDispose: handleTerminalDispose,
    onPasteShortcut: handlePasteShortcut,
    onReady: handleTerminalReady,
    onResize: handleTerminalResize,
    onScroll: updateTerminalScrollState,
  });

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const sessionId = session?.id ?? null;
    activeSessionIdRef.current = sessionId;
    lastResizeRef.current = null;

    if (!terminal || !sessionId) {
      resetScrollState();
      return undefined;
    }

    onError(null);
    resetTerminalOutput(terminal);
    publishTerminalSize(terminal.cols, terminal.rows);
    sendResize(terminal.cols, terminal.rows);
    return undefined;
  }, [
    onError,
    publishTerminalSize,
    resetScrollState,
    resetTerminalOutput,
    sendResize,
    session?.id,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !snapshot) {
      return;
    }

    if (snapshot.sessionId !== activeSessionIdRef.current) {
      return;
    }

    resetTerminalOutput(terminal);
    if (snapshot.buffer) {
      queueTerminalWrite(snapshot.buffer);
    }
    publishTerminalSize(terminal.cols, terminal.rows);
    sendResize(terminal.cols, terminal.rows);
  }, [
    publishTerminalSize,
    queueTerminalWrite,
    resetTerminalOutput,
    sendResize,
    snapshot,
  ]);

  useEffect(() => {
    if (!output || output.sessionId !== activeSessionIdRef.current) {
      return;
    }

    queueTerminalWrite(output.data);
  }, [output, queueTerminalWrite]);

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
            onClick={fitTerminal}
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
