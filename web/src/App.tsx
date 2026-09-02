import { useEffect, useRef, useState } from "react";
import { PromptPanel } from "./components/PromptPanel";
import { SessionPanel } from "./components/SessionPanel";
import { TerminalPane } from "./components/TerminalPane";
import { useAppController } from "./useAppController";
import type { TerminalFocusRequest } from "./types";

type PanelCollapseState = {
  prompts: boolean;
  sessions: boolean;
};

const panelCollapseStorageKey = "termrail:panel-collapse:v1";
const defaultPanelCollapseState: PanelCollapseState = {
  prompts: false,
  sessions: false,
};

function readPanelCollapseState(): PanelCollapseState {
  try {
    const raw = window.localStorage.getItem(panelCollapseStorageKey);
    if (!raw) {
      return defaultPanelCollapseState;
    }

    const parsed = JSON.parse(raw) as Partial<PanelCollapseState>;
    return {
      prompts:
        typeof parsed.prompts === "boolean"
          ? parsed.prompts
          : defaultPanelCollapseState.prompts,
      sessions:
        typeof parsed.sessions === "boolean"
          ? parsed.sessions
          : defaultPanelCollapseState.sessions,
    };
  } catch {
    return defaultPanelCollapseState;
  }
}

function writePanelCollapseState(state: PanelCollapseState): void {
  try {
    window.localStorage.setItem(panelCollapseStorageKey, JSON.stringify(state));
  } catch {
    // Layout persistence is best-effort.
  }
}

export function App() {
  const app = useAppController();
  const [collapsedPanels, setCollapsedPanels] = useState(
    readPanelCollapseState,
  );
  const terminalFocusRequestCounterRef = useRef(0);
  const [terminalFocusRequest, setTerminalFocusRequest] =
    useState<TerminalFocusRequest | null>(null);
  const appShellClassName = [
    "app-shell",
    collapsedPanels.sessions ? "sessions-collapsed" : "",
    collapsedPanels.prompts ? "prompts-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    writePanelCollapseState(collapsedPanels);
  }, [collapsedPanels]);

  const requestTerminalFocus = (sessionId: string, terminalId: string) => {
    terminalFocusRequestCounterRef.current += 1;
    setTerminalFocusRequest({
      id: terminalFocusRequestCounterRef.current,
      sessionId,
      terminalId,
    });
  };

  const selectSessionAndFocus = (sessionId: string) => {
    app.selectSession(sessionId);
    const session = app.sessions.find((item) => item.id === sessionId);
    const terminalId =
      app.activeTerminalIds[sessionId] ?? session?.terminals[0]?.id ?? null;
    if (terminalId) {
      requestTerminalFocus(sessionId, terminalId);
    }
  };

  const startTerminalAndFocus = (sessionId: string, terminalId: string) => {
    app.selectTerminal(sessionId, terminalId);
    requestTerminalFocus(sessionId, terminalId);
    void app
      .runTerminalAction(sessionId, terminalId, "start")
      .finally(() => requestTerminalFocus(sessionId, terminalId));
  };

  return (
    <main className={appShellClassName}>
      <SessionPanel
        actionTerminalKey={app.actionTerminalKey}
        activeTerminalIds={app.activeTerminalIds}
        collapsed={collapsedPanels.sessions}
        error={app.sessionError}
        loading={app.loading}
        onCreateSession={app.createSession}
        onDeleteSession={app.deleteSession}
        onEditSession={app.updateSession}
        onRefresh={app.loadSessions}
        onSelect={selectSessionAndFocus}
        onStart={startTerminalAndFocus}
        onStop={(sessionId, terminalId) =>
          void app.runTerminalAction(sessionId, terminalId, "stop")
        }
        onToggleCollapsed={() =>
          setCollapsedPanels((current) => ({
            ...current,
            sessions: !current.sessions,
          }))
        }
        sessionAttention={app.sessionAttention}
        selectedSessionId={app.selectedSessionId}
        sessions={app.sessions}
        terminalStatuses={app.terminalStatuses}
      />
      <TerminalPane
        actionTerminalKey={app.actionTerminalKey}
        connectionState={app.streamConnectionState}
        error={app.terminalError}
        focusRequest={terminalFocusRequest}
        inputRequest={app.terminalInputRequest}
        onCreateTerminal={app.createTerminal}
        onDeleteTerminal={app.deleteTerminal}
        onError={app.setTerminalError}
        onInput={app.sendTerminalInput}
        onFocusRequest={requestTerminalFocus}
        onResize={app.sendTerminalResize}
        onSelectTerminal={app.selectTerminal}
        onSize={app.setTerminalSize}
        onSnapshotRequest={app.requestTerminalSnapshot}
        onVisibleOutputApplied={app.markVisibleTerminalOutputApplied}
        onStartTerminal={startTerminalAndFocus}
        onStopTerminal={(sessionId, terminalId) =>
          void app.runTerminalAction(sessionId, terminalId, "stop")
        }
        onUpdateTerminal={app.updateTerminal}
        session={app.selectedSession}
        status={app.selectedTerminalStatus}
        terminal={app.selectedTerminal}
        terminalAttention={app.selectedTerminalAttention}
        terminalStatuses={app.selectedTerminalStatuses}
        terminalStream={app.terminalStream}
      />
      <PromptPanel
        collapsed={collapsedPanels.prompts}
        error={app.promptError}
        onTerminalInput={app.requestTerminalInput}
        onToggleCollapsed={() =>
          setCollapsedPanels((current) => ({
            ...current,
            prompts: !current.prompts,
          }))
        }
        onUpdatePrompts={app.updatePrompts}
        prompts={app.prompts}
        promptsLoaded={app.promptsLoaded}
        session={app.selectedSession}
        status={app.selectedTerminalStatus}
      />
    </main>
  );
}
