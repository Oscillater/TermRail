import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import type {
  RuntimeStatus,
  SessionConfig,
  StreamConnectionState,
  TerminalConfig,
  TerminalInputRequest,
  TerminalOutputDelivery,
  TerminalSessionSnapshot,
  TerminalSize,
} from "../types";
import { useTerminalClipboard } from "../hooks/useTerminalClipboard";
import { useTerminalScroll } from "../hooks/useTerminalScroll";
import { useTerminalWriter } from "../hooks/useTerminalWriter";
import { useXtermInstance } from "../hooks/useXtermInstance";
import { formatDate, statusLabel } from "../utils/activity";
import { messageFromError } from "../utils/errors";
import { clampTerminalSize } from "../utils/terminal";

type TerminalDraft = {
  name: string;
  command: string;
};

type TerminalPaneProps = {
  actionTerminalKey: string | null;
  connectionState: StreamConnectionState;
  error: string | null;
  inputRequest: TerminalInputRequest | null;
  onCreateTerminal: (
    sessionId: string,
    terminal: Pick<TerminalConfig, "name" | "command">,
  ) => Promise<TerminalConfig>;
  onDeleteTerminal: (
    sessionId: string,
    terminalId: string,
  ) => Promise<TerminalConfig>;
  onError: (message: string | null) => void;
  onInput: (sessionId: string, terminalId: string, data: string) => boolean;
  onResize: (
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ) => boolean;
  onSelectTerminal: (sessionId: string, terminalId: string) => void;
  onSize: (size: TerminalSize) => void;
  onStartTerminal: (sessionId: string, terminalId: string) => void;
  onStopTerminal: (sessionId: string, terminalId: string) => void;
  output: TerminalOutputDelivery | null;
  session: SessionConfig | null;
  snapshot: TerminalSessionSnapshot | null;
  status: RuntimeStatus | undefined;
  terminal: TerminalConfig | null;
  terminalStatuses: Record<string, RuntimeStatus>;
};

function terminalActionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

export function TerminalPane({
  actionTerminalKey,
  connectionState,
  error,
  inputRequest,
  onCreateTerminal,
  onDeleteTerminal,
  onError,
  onInput,
  onResize,
  onSelectTerminal,
  onSize,
  onStartTerminal,
  onStopTerminal,
  output,
  session,
  snapshot,
  status,
  terminal,
  terminalStatuses,
}: TerminalPaneProps) {
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const statusRef = useRef<RuntimeStatus | undefined>(status);
  const terminalRef = useRef<Terminal | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const connectionStateRef = useRef<StreamConnectionState>(connectionState);
  const [terminalDraft, setTerminalDraft] = useState<TerminalDraft>({
    name: "",
    command: "",
  });
  const [terminalFormOpen, setTerminalFormOpen] = useState(false);
  const [terminalFormError, setTerminalFormError] = useState<string | null>(
    null,
  );
  const [savingTerminal, setSavingTerminal] = useState(false);
  const [deletingTerminalId, setDeletingTerminalId] = useState<string | null>(
    null,
  );
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
      const terminalId = activeTerminalIdRef.current;

      if (!data) {
        return true;
      }

      if (!sessionId || !terminalId) {
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

      if (!onInput(sessionId, terminalId, data)) {
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
      const terminalId = activeTerminalIdRef.current;
      const size = clampTerminalSize(cols, rows);
      if (
        !sessionId ||
        !terminalId ||
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
      onResize(sessionId, terminalId, size.cols, size.rows);
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

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    const xterm = terminalRef.current;
    const sessionId = session?.id ?? null;
    const terminalId = terminal?.id ?? null;
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
    session?.id,
    terminal?.id,
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

  const openTerminalForm = () => {
    const nextIndex = (session?.terminals.length ?? 0) + 1;
    setTerminalDraft({
      name: `Terminal ${nextIndex}`,
      command: terminal?.command ?? session?.command ?? "",
    });
    setTerminalFormError(null);
    setTerminalFormOpen(true);
  };

  const closeTerminalForm = () => {
    setTerminalFormOpen(false);
    setTerminalFormError(null);
  };

  const handleTerminalSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) {
      return;
    }

    const nextTerminal = {
      name: terminalDraft.name.trim(),
      command: terminalDraft.command.trim(),
    };
    if (!nextTerminal.name || !nextTerminal.command) {
      setTerminalFormError("name and command are required");
      return;
    }

    setSavingTerminal(true);
    setTerminalFormError(null);
    try {
      await onCreateTerminal(session.id, nextTerminal);
      closeTerminalForm();
    } catch (formError) {
      setTerminalFormError(
        messageFromError(formError, "Failed to create terminal"),
      );
    } finally {
      setSavingTerminal(false);
    }
  };

  const handleDeleteTerminal = async (target: TerminalConfig) => {
    if (!session) {
      return;
    }

    const targetStatus = terminalStatuses[target.id];
    if (targetStatus?.state === "running") {
      const confirmed = window.confirm(
        `Close running terminal "${target.name}"? The process will be stopped.`,
      );
      if (!confirmed) {
        return;
      }
    }

    setDeletingTerminalId(target.id);
    setTerminalFormError(null);
    try {
      await onDeleteTerminal(session.id, target.id);
    } catch (deleteError) {
      setTerminalFormError(
        messageFromError(deleteError, "Failed to close terminal"),
      );
    } finally {
      setDeletingTerminalId(null);
    }
  };

  const running = status?.state === "running";
  const activeActionKey =
    session && terminal ? terminalActionKey(session.id, terminal.id) : null;
  const activeActionBusy =
    Boolean(activeActionKey) && activeActionKey === actionTerminalKey;
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
            disabled={!session || !terminal || running || activeActionBusy}
            onClick={() =>
              session && terminal
                ? onStartTerminal(session.id, terminal.id)
                : undefined
            }
            type="button"
          >
            Start
          </button>
          <button
            className="ghost-button compact"
            disabled={!session || !terminal || !running || activeActionBusy}
            onClick={() =>
              session && terminal
                ? onStopTerminal(session.id, terminal.id)
                : undefined
            }
            type="button"
          >
            Stop
          </button>
          <button
            className="ghost-button compact"
            disabled={!session || !terminal}
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

      <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
        {session?.terminals.map((item) => {
          const selected = item.id === terminal?.id;
          const itemStatus = terminalStatuses[item.id];
          const deleting = deletingTerminalId === item.id;
          return (
            <span
              className={`terminal-tab${selected ? " selected" : ""}`}
              key={item.id}
            >
              <button
                aria-selected={selected}
                className="terminal-tab-button"
                onClick={() => session && onSelectTerminal(session.id, item.id)}
                role="tab"
                title={item.command}
                type="button"
              >
                <span
                  className={`terminal-tab-dot ${
                    itemStatus?.state === "running" ? "run" : "stop"
                  }`}
                />
                <span className="terminal-tab-name">{item.name}</span>
              </button>
              <button
                aria-label={`Close ${item.name}`}
                className="terminal-tab-close"
                disabled={deleting}
                onClick={() => void handleDeleteTerminal(item)}
                type="button"
              >
                {deleting ? "..." : "x"}
              </button>
            </span>
          );
        })}
        <button
          aria-label="New terminal"
          className="terminal-tab-add"
          disabled={!session}
          onClick={openTerminalForm}
          type="button"
        >
          +
        </button>
      </div>

      {terminalFormOpen ? (
        <form className="terminal-new-form" onSubmit={handleTerminalSubmit}>
          <input
            disabled={savingTerminal}
            onChange={(event) =>
              setTerminalDraft((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
            placeholder="Name"
            required
            value={terminalDraft.name}
          />
          <input
            disabled={savingTerminal}
            onChange={(event) =>
              setTerminalDraft((current) => ({
                ...current,
                command: event.target.value,
              }))
            }
            placeholder="Command"
            required
            value={terminalDraft.command}
          />
          <button
            className="primary-button compact"
            disabled={savingTerminal}
            type="submit"
          >
            {savingTerminal ? "Creating" : "Create"}
          </button>
          <button
            className="ghost-button compact"
            disabled={savingTerminal}
            onClick={closeTerminalForm}
            type="button"
          >
            Cancel
          </button>
        </form>
      ) : null}
      {terminalFormError ? (
        <div className="form-error">{terminalFormError}</div>
      ) : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <div
        className="terminal-frame"
        onClick={() => terminalRef.current?.focus()}
      >
        <div className="terminal-host" ref={containerRef} />
        {!terminal ? (
          <div className="terminal-empty-overlay">
            <h3>No terminal tabs</h3>
            <button
              className="primary-button"
              disabled={!session}
              onClick={(event) => {
                event.stopPropagation();
                openTerminalForm();
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
      <footer className="terminal-footer">
        <span>Tab {terminal?.name ?? "-"}</span>
        <span>PID {status?.pid ?? "-"}</span>
        <span>Started {formatDate(status?.startedAt ?? null)}</span>
        <span>Last output {formatDate(status?.lastOutputAt ?? null)}</span>
        <span>Buffer {status?.bufferLength ?? 0}</span>
      </footer>
    </section>
  );
}
