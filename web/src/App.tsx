import { useEffect, useState } from "react";
import { PromptPanel } from "./components/PromptPanel";
import { SessionPanel } from "./components/SessionPanel";
import { TerminalPane } from "./components/TerminalPane";
import { useAppController } from "./useAppController";

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

  return (
    <main className={appShellClassName}>
      <SessionPanel
        actionSessionId={app.actionSessionId}
        collapsed={collapsedPanels.sessions}
        error={app.sessionError}
        loading={app.loading}
        onCreateSession={app.createSession}
        onDeleteSession={app.deleteSession}
        onEditSession={app.updateSession}
        onRefresh={app.loadSessions}
        onSelect={app.selectSession}
        onStart={(sessionId) => void app.runAction(sessionId, "start")}
        onStop={(sessionId) => void app.runAction(sessionId, "stop")}
        onToggleCollapsed={() =>
          setCollapsedPanels((current) => ({
            ...current,
            sessions: !current.sessions,
          }))
        }
        outputActivities={app.outputActivities}
        selectedSessionId={app.selectedSessionId}
        sessions={app.sessions}
        statuses={app.statuses}
      />
      <TerminalPane
        connectionState={app.streamConnectionState}
        error={app.terminalError}
        inputRequest={app.terminalInputRequest}
        onError={app.setTerminalError}
        onInput={app.sendTerminalInput}
        onResize={app.sendTerminalResize}
        onSize={app.setTerminalSize}
        output={app.terminalOutput}
        session={app.selectedSession}
        snapshot={app.terminalSnapshot}
        status={app.selectedStatus}
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
        status={app.selectedStatus}
      />
    </main>
  );
}
