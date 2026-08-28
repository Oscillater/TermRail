import { PromptPanel } from "./components/PromptPanel";
import { SessionPanel } from "./components/SessionPanel";
import { TerminalPane } from "./components/TerminalPane";
import { useAppController } from "./useAppController";

export function App() {
  const app = useAppController();

  return (
    <main className="app-shell">
      <SessionPanel
        actionSessionId={app.actionSessionId}
        error={app.sessionError}
        loading={app.loading}
        onCreateSession={app.createSession}
        onDeleteSession={app.deleteSession}
        onEditSession={app.updateSession}
        onRefresh={app.loadSessions}
        onSelect={app.selectSession}
        onStart={(sessionId) => void app.runAction(sessionId, "start")}
        onStop={(sessionId) => void app.runAction(sessionId, "stop")}
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
        error={app.promptError}
        onTerminalInput={app.requestTerminalInput}
        onUpdatePrompts={app.updatePrompts}
        prompts={app.prompts}
        promptsLoaded={app.promptsLoaded}
        session={app.selectedSession}
        status={app.selectedStatus}
      />
    </main>
  );
}
