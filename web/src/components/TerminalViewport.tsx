import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { Terminal } from "@xterm/xterm";
import type {
  RuntimeStatus,
  StreamConnectionState,
  TerminalInputRequest,
  TerminalOutputDelivery,
  TerminalSessionSnapshot,
  TerminalSize,
} from "../types";
import { useTerminalClipboard } from "../hooks/useTerminalClipboard";
import { useTerminalScroll } from "../hooks/useTerminalScroll";
import { useTerminalWriter } from "../hooks/useTerminalWriter";
import { useXtermInstance } from "../hooks/useXtermInstance";
import { clampTerminalSize } from "../utils/terminal";

export type TerminalViewportHandle = {
  focus: () => void;
  fit: () => void;
};

type TerminalViewportProps = {
  connectionState: StreamConnectionState;
  inputRequest: TerminalInputRequest | null;
  keyboardOwner: "terminal" | "form";
  onCreateTerminalClick: () => void;
  onError: (message: string | null) => void;
  onFocusFormRequest: () => void;
  onInput: (sessionId: string, terminalId: string, data: string) => boolean;
  onResize: (
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ) => boolean;
  onSize: (size: TerminalSize) => void;
  output: TerminalOutputDelivery | null;
  savingTerminal: boolean;
  sessionId: string | null;
  snapshot: TerminalSessionSnapshot | null;
  status: RuntimeStatus | undefined;
  terminalExists: boolean;
  terminalId: string | null;
};

export const TerminalViewport = forwardRef<
  TerminalViewportHandle,
  TerminalViewportProps
>(function TerminalViewport(
  {
    connectionState,
    inputRequest,
    keyboardOwner,
    onCreateTerminalClick,
    onError,
    onFocusFormRequest,
    onInput,
    onResize,
    onSize,
    output,
    savingTerminal,
    sessionId,
    snapshot,
    status,
    terminalExists,
    terminalId,
  },
  ref,
) {
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef<RuntimeStatus | undefined>(status);
  const terminalRef = useRef<Terminal | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const connectionStateRef = useRef<StreamConnectionState>(connectionState);
  const keyboardOwnerRef = useRef(keyboardOwner);
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
      const activeSessionId = activeSessionIdRef.current;
      const activeTerminalId = activeTerminalIdRef.current;

      if (!data) {
        return true;
      }

      if (!activeSessionId || !activeTerminalId) {
        if (reportErrors) {
          onError("Select a terminal before sending input");
        }
        return false;
      }

      if (statusRef.current?.state !== "running") {
        if (reportErrors) {
          onError("Start the selected terminal before sending input");
        }
        return false;
      }

      if (connectionStateRef.current !== "connected") {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }

      if (!onInput(activeSessionId, activeTerminalId, data)) {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }
      if (keyboardOwnerRef.current === "terminal") {
        terminalRef.current?.focus();
      }
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
      const activeSessionId = activeSessionIdRef.current;
      const activeTerminalId = activeTerminalIdRef.current;
      const size = clampTerminalSize(cols, rows);
      if (
        !activeSessionId ||
        !activeTerminalId ||
        connectionStateRef.current !== "connected"
      ) {
        return;
      }

      if (
        lastResizeRef.current?.cols === size.cols &&
        lastResizeRef.current.rows === size.rows
      ) {
        return;
      }

      lastResizeRef.current = size;
      onResize(activeSessionId, activeTerminalId, size.cols, size.rows);
    },
    [onResize],
  );

  const handleTerminalReady = useCallback(
    (xterm: Terminal) => {
      publishTerminalSize(xterm.cols, xterm.rows);
      sendResize(xterm.cols, xterm.rows);
      updateTerminalScrollState(xterm);
    },
    [publishTerminalSize, sendResize, updateTerminalScrollState],
  );

  const handleTerminalResize = useCallback(
    (xterm: Terminal, cols: number, rows: number) => {
      publishTerminalSize(cols, rows);
      sendResize(cols, rows);
      updateTerminalScrollState(xterm);
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
    (xterm: Terminal) => {
      void copyTerminalSelection(xterm);
    },
    [copyTerminalSelection],
  );

  const handlePasteShortcut = useCallback(
    (xterm: Terminal) => {
      void pasteTerminalClipboard(xterm);
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

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        terminalRef.current?.focus();
      },
      fit: () => {
        fitTerminal();
        if (keyboardOwnerRef.current === "form") {
          onFocusFormRequest();
        }
      },
    }),
    [fitTerminal, onFocusFormRequest],
  );

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    const xterm = terminalRef.current;
    activeSessionIdRef.current = sessionId;
    activeTerminalIdRef.current = terminalId;
    lastResizeRef.current = null;

    if (!xterm || !sessionId || !terminalId) {
      if (xterm) {
        resetTerminalOutput(xterm);
      }
      resetScrollState();
      return undefined;
    }

    onError(null);
    resetTerminalOutput(xterm);
    publishTerminalSize(xterm.cols, xterm.rows);
    sendResize(xterm.cols, xterm.rows);
    return undefined;
  }, [
    onError,
    publishTerminalSize,
    resetScrollState,
    resetTerminalOutput,
    sendResize,
    sessionId,
    terminalId,
  ]);

  useEffect(() => {
    const xterm = terminalRef.current;
    if (!xterm || !snapshot) {
      return;
    }

    if (
      snapshot.sessionId !== activeSessionIdRef.current ||
      snapshot.terminalId !== activeTerminalIdRef.current
    ) {
      return;
    }

    resetTerminalOutput(xterm);
    if (snapshot.buffer) {
      queueTerminalWrite(snapshot.buffer);
    }
    publishTerminalSize(xterm.cols, xterm.rows);
    sendResize(xterm.cols, xterm.rows);
  }, [
    publishTerminalSize,
    queueTerminalWrite,
    resetTerminalOutput,
    sendResize,
    snapshot,
  ]);

  useEffect(() => {
    if (
      !output ||
      output.sessionId !== activeSessionIdRef.current ||
      output.terminalId !== activeTerminalIdRef.current
    ) {
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

  useLayoutEffect(() => {
    keyboardOwnerRef.current = keyboardOwner;
    const xterm = terminalRef.current;
    if (keyboardOwner === "terminal") {
      if (xterm) {
        xterm.options.disableStdin = false;
      }
      return undefined;
    }

    if (xterm) {
      xterm.options.disableStdin = true;
      xterm.blur();
    }

    return () => {
      keyboardOwnerRef.current = "terminal";
      if (xterm) {
        xterm.options.disableStdin = false;
      }
    };
  }, [keyboardOwner]);

  const focusTerminalOrForm = () => {
    if (keyboardOwner === "form") {
      onFocusFormRequest();
      return;
    }
    terminalRef.current?.focus();
  };

  const hasScrollback = scrollState.baseY > 0;
  const scrollProgress = hasScrollback
    ? scrollState.viewportY / scrollState.baseY
    : 0;
  const scrollThumbTop = `calc(${(scrollProgress * 100).toFixed(3)}% - ${(
    scrollProgress * 34
  ).toFixed(1)}px)`;

  return (
    <div className="terminal-frame" onClick={focusTerminalOrForm}>
      <div className="terminal-host" ref={containerRef} />
      {!terminalExists ? (
        <div className="terminal-empty-overlay">
          <h3>No terminal tabs</h3>
          <button
            className="primary-button"
            disabled={!sessionId || savingTerminal}
            onClick={(event) => {
              event.stopPropagation();
              onCreateTerminalClick();
            }}
            type="button"
          >
            New terminal
          </button>
        </div>
      ) : null}
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
  );
});
