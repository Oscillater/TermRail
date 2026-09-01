import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  RuntimeStatus,
  SessionConfig,
  StreamConnectionState,
  TerminalConfig,
  TerminalInputRequest,
  TerminalSize,
} from "../types";
import type { TerminalStream } from "../terminalStream";
import { formatDate, statusLabel } from "../utils/activity";
import { messageFromError } from "../utils/errors";
import {
  TerminalEditorForm,
  type TerminalEditorDraft,
} from "./TerminalEditorForm";
import {
  TerminalViewport,
  type TerminalViewportHandle,
} from "./TerminalViewport";

type TerminalCreateTarget = {
  sessionId: string;
};

type TerminalEditTarget = {
  sessionId: string;
  terminalId: string;
};

type TerminalEditorState =
  | { mode: "view" }
  | {
      mode: "create";
      target: TerminalCreateTarget;
      draft: TerminalEditorDraft;
      error: string | null;
    }
  | {
      mode: "edit";
      target: TerminalEditTarget;
      draft: TerminalEditorDraft;
      error: string | null;
    }
  | {
      mode: "saving";
      submitMode: "create";
      target: TerminalCreateTarget;
      draft: TerminalEditorDraft;
    }
  | {
      mode: "saving";
      submitMode: "edit";
      target: TerminalEditTarget;
      draft: TerminalEditorDraft;
    };

type EditableTerminalEditorState = Extract<
  TerminalEditorState,
  { mode: "create" | "edit" }
>;

type SavingTerminalEditorState = Extract<
  TerminalEditorState,
  { mode: "saving" }
>;

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
  onUpdateTerminal: (
    sessionId: string,
    terminalId: string,
    terminal: Pick<TerminalConfig, "name" | "command">,
  ) => Promise<TerminalConfig>;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
  terminal: TerminalConfig | null;
  terminalStatuses: Record<string, RuntimeStatus>;
  terminalStream: TerminalStream;
};

function terminalActionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function editorTargetsCurrentSelection(
  editor: TerminalEditorState,
  sessionId: string | null,
  terminalId: string | null,
): boolean {
  switch (editor.mode) {
    case "view":
      return true;
    case "create":
      return editor.target.sessionId === sessionId;
    case "edit":
      return (
        editor.target.sessionId === sessionId &&
        editor.target.terminalId === terminalId
      );
    case "saving":
      if (editor.submitMode === "create") {
        return editor.target.sessionId === sessionId;
      }
      return (
        editor.target.sessionId === sessionId &&
        editor.target.terminalId === terminalId
      );
  }
}

function editorFormState(editor: TerminalEditorState): {
  mode: "create" | "edit";
  draft: TerminalEditorDraft;
  error: string | null;
  saving: boolean;
} | null {
  switch (editor.mode) {
    case "view":
      return null;
    case "create":
    case "edit":
      return {
        mode: editor.mode,
        draft: editor.draft,
        error: editor.error,
        saving: false,
      };
    case "saving":
      return {
        mode: editor.submitMode,
        draft: editor.draft,
        error: null,
        saving: true,
      };
  }
}

function sameSavingEditor(
  current: TerminalEditorState,
  expected: SavingTerminalEditorState,
): boolean {
  if (
    current.mode !== "saving" ||
    current.submitMode !== expected.submitMode ||
    current.target.sessionId !== expected.target.sessionId
  ) {
    return false;
  }

  if (current.submitMode === "edit" && expected.submitMode === "edit") {
    return current.target.terminalId === expected.target.terminalId;
  }

  return true;
}

function restoreEditorAfterSaveFailure(
  editor: SavingTerminalEditorState,
  error: string,
): TerminalEditorState {
  if (editor.submitMode === "create") {
    return {
      mode: "create",
      target: editor.target,
      draft: editor.draft,
      error,
    };
  }

  return {
    mode: "edit",
    target: editor.target,
    draft: editor.draft,
    error,
  };
}

function savingEditorFrom(
  editor: EditableTerminalEditorState,
): SavingTerminalEditorState {
  if (editor.mode === "create") {
    return {
      mode: "saving",
      submitMode: "create",
      target: editor.target,
      draft: editor.draft,
    };
  }

  return {
    mode: "saving",
    submitMode: "edit",
    target: editor.target,
    draft: editor.draft,
  };
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
  onUpdateTerminal,
  session,
  status,
  terminal,
  terminalStatuses,
  terminalStream,
}: TerminalPaneProps) {
  const viewportRef = useRef<TerminalViewportHandle | null>(null);
  const terminalCommandInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<TerminalEditorState>({ mode: "view" });
  const [editor, setEditor] = useState<TerminalEditorState>({ mode: "view" });
  const [deletingTerminalId, setDeletingTerminalId] = useState<string | null>(
    null,
  );

  const updateEditor = useCallback(
    (
      next:
        | TerminalEditorState
        | ((current: TerminalEditorState) => TerminalEditorState),
    ) => {
      setEditor((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        editorRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

  const focusTerminalCommandInput = useCallback((select = false) => {
    const input = terminalCommandInputRef.current;
    if (!input || input.disabled) {
      return;
    }

    input.focus({ preventScroll: true });
    if (select) {
      input.select();
    }
  }, []);

  const focusTerminalCommandInputSoon = useCallback(
    (select = false) => {
      window.requestAnimationFrame(() => {
        focusTerminalCommandInput(select);
      });
    },
    [focusTerminalCommandInput],
  );

  const focusTerminalSoon = useCallback(() => {
    window.requestAnimationFrame(() => {
      viewportRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    updateEditor((current) =>
      editorTargetsCurrentSelection(
        current,
        session?.id ?? null,
        terminal?.id ?? null,
      )
        ? current
        : { mode: "view" },
    );
  }, [session?.id, terminal?.id, updateEditor]);

  const form = editorFormState(editor);
  const formOpen = form !== null;
  const isSaving = editor.mode === "saving";
  const keyboardOwner = formOpen ? "form" : "terminal";

  useLayoutEffect(() => {
    if (!formOpen || isSaving) {
      return;
    }

    focusTerminalCommandInput(true);
  }, [focusTerminalCommandInput, formOpen, isSaving]);

  const openTerminalForm = useCallback(() => {
    if (!session) {
      return;
    }

    updateEditor({
      mode: "create",
      target: { sessionId: session.id },
      draft: {
        name: `Terminal ${session.terminals.length + 1}`,
        command: "",
      },
      error: null,
    });
  }, [session, updateEditor]);

  const openTerminalEditForm = useCallback(() => {
    if (!session || !terminal || status?.state === "running") {
      return;
    }

    updateEditor({
      mode: "edit",
      target: {
        sessionId: session.id,
        terminalId: terminal.id,
      },
      draft: {
        name: terminal.name,
        command: terminal.command,
      },
      error: null,
    });
  }, [session, status?.state, terminal, updateEditor]);

  const closeTerminalForm = useCallback(() => {
    updateEditor({ mode: "view" });
    focusTerminalSoon();
  }, [focusTerminalSoon, updateEditor]);

  const updateTerminalDraft = useCallback(
    (draft: TerminalEditorDraft) => {
      updateEditor((current) => {
        if (current.mode !== "create" && current.mode !== "edit") {
          return current;
        }
        return { ...current, draft };
      });
    },
    [updateEditor],
  );

  const handleTerminalSubmit = useCallback(async () => {
    const currentEditor = editorRef.current;
    if (currentEditor.mode !== "create" && currentEditor.mode !== "edit") {
      return;
    }

    const nextTerminal = {
      name: currentEditor.draft.name.trim(),
      command: currentEditor.draft.command.trim(),
    };
    if (!nextTerminal.name || !nextTerminal.command) {
      updateEditor((current) => {
        if (current.mode !== "create" && current.mode !== "edit") {
          return current;
        }
        return { ...current, error: "name and command are required" };
      });
      focusTerminalCommandInputSoon(true);
      return;
    }

    const savingEditor = savingEditorFrom(currentEditor);
    updateEditor(savingEditor);

    try {
      if (savingEditor.submitMode === "create") {
        await onCreateTerminal(savingEditor.target.sessionId, nextTerminal);
      } else {
        await onUpdateTerminal(
          savingEditor.target.sessionId,
          savingEditor.target.terminalId,
          nextTerminal,
        );
      }

      if (sameSavingEditor(editorRef.current, savingEditor)) {
        updateEditor({ mode: "view" });
        focusTerminalSoon();
      }
    } catch (formError) {
      if (sameSavingEditor(editorRef.current, savingEditor)) {
        updateEditor(
          restoreEditorAfterSaveFailure(
            savingEditor,
            messageFromError(
              formError,
              savingEditor.submitMode === "edit"
                ? "Failed to update terminal"
                : "Failed to create terminal",
            ),
          ),
        );
        focusTerminalCommandInputSoon(true);
      }
    }
  }, [
    focusTerminalCommandInputSoon,
    focusTerminalSoon,
    onCreateTerminal,
    onUpdateTerminal,
    updateEditor,
  ]);

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
    onError(null);
    try {
      await onDeleteTerminal(session.id, target.id);
    } catch (deleteError) {
      onError(messageFromError(deleteError, "Failed to close terminal"));
    } finally {
      setDeletingTerminalId(null);
    }
  };

  const running = status?.state === "running";
  const activeActionKey =
    session && terminal ? terminalActionKey(session.id, terminal.id) : null;
  const activeActionBusy =
    Boolean(activeActionKey) && activeActionKey === actionTerminalKey;

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
            disabled={
              !session ||
              !terminal ||
              running ||
              activeActionBusy ||
              isSaving ||
              formOpen
            }
            onClick={openTerminalEditForm}
            type="button"
          >
            Edit
          </button>
          <button
            className="ghost-button compact"
            disabled={!session || !terminal}
            onClick={() => viewportRef.current?.fit()}
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
          disabled={!session || isSaving}
          onClick={openTerminalForm}
          type="button"
        >
          +
        </button>
      </div>

      {form ? (
        <TerminalEditorForm
          commandInputRef={terminalCommandInputRef}
          draft={form.draft}
          error={form.error}
          mode={form.mode}
          onCancel={closeTerminalForm}
          onChange={updateTerminalDraft}
          onSubmit={handleTerminalSubmit}
          saving={form.saving}
        />
      ) : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <TerminalViewport
        connectionState={connectionState}
        inputRequest={inputRequest}
        keyboardOwner={keyboardOwner}
        onCreateTerminalClick={openTerminalForm}
        onError={onError}
        onFocusFormRequest={() => focusTerminalCommandInput(false)}
        onInput={onInput}
        onResize={onResize}
        onSize={onSize}
        ref={viewportRef}
        savingTerminal={isSaving}
        sessionId={session?.id ?? null}
        status={status}
        terminalExists={Boolean(terminal)}
        terminalId={terminal?.id ?? null}
        terminalStream={terminalStream}
      />

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
