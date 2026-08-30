import { useState } from "react";
import type {
  OutputActivities,
  OutputActivity,
  RuntimeStatus,
  SessionConfig,
} from "../types";
import {
  activitySortValue,
  outputActivityDetail,
  outputActivityLabel,
  statusLabel,
} from "../utils/activity";
import { messageFromError } from "../utils/errors";
import {
  sessionFromDraft,
  type SessionEditorState,
  useSessionDraft,
  validateSessionDraft,
} from "../hooks/useSessionDraft";
import { SessionForm } from "./SessionForm";

type SessionPanelProps = {
  actionTerminalKey: string | null;
  activeTerminalIds: Record<string, string | null>;
  collapsed: boolean;
  error: string | null;
  loading: boolean;
  onCreateSession: (
    session: Omit<SessionConfig, "terminals">,
  ) => Promise<SessionConfig>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onEditSession: (
    sessionId: string,
    session: Omit<SessionConfig, "terminals">,
  ) => Promise<SessionConfig>;
  onRefresh: () => void;
  onSelect: (sessionId: string) => void;
  onStart: (sessionId: string, terminalId: string) => void;
  onStop: (sessionId: string, terminalId: string) => void;
  onToggleCollapsed: () => void;
  outputActivities: OutputActivities;
  selectedSessionId: string | null;
  sessions: SessionConfig[];
  statuses: Record<string, RuntimeStatus>;
  terminalStatuses: Record<string, Record<string, RuntimeStatus>>;
};

function terminalActionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

export function SessionPanel({
  actionTerminalKey,
  activeTerminalIds,
  collapsed,
  error,
  loading,
  onCreateSession,
  onDeleteSession,
  onEditSession,
  onRefresh,
  onSelect,
  onStart,
  onStop,
  onToggleCollapsed,
  outputActivities,
  selectedSessionId,
  sessions,
  statuses,
  terminalStatuses,
}: SessionPanelProps) {
  const [editor, setEditor] = useState<SessionEditorState | null>(null);
  const { draft, loadDraft, resetDraft, updateDraft } = useSessionDraft();
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const visibleActivityItems = sessions
    .map((session, index) => {
      const outputActivity = outputActivities[session.id];
      const status = statuses[session.id];
      const activity =
        outputActivity ??
        (status?.state === "running"
          ? {
              state: "running" as const,
              updatedAt: 0,
            }
          : undefined);

      return { activity, index, session };
    })
    .filter(
      (
        item,
      ): item is {
        activity: OutputActivity;
        index: number;
        session: SessionConfig;
      } => Boolean(item.activity),
    );
  const quietActivityCount = visibleActivityItems.filter(
    (item) =>
      item.activity.state === "quiet" || item.activity.state === "stopped",
  ).length;
  const activeActivityCount = visibleActivityItems.filter(
    (item) =>
      item.activity.state === "working" || item.activity.state === "running",
  ).length;
  const activitySummary =
    quietActivityCount > 0
      ? `${quietActivityCount} ready`
      : activeActivityCount > 0
        ? `${activeActivityCount} active`
        : "Idle";
  const sortedActivityItems = [...visibleActivityItems].sort(
    (left, right) =>
      activitySortValue(left.activity.state) -
        activitySortValue(right.activity.state) || left.index - right.index,
  );

  const openCreateEditor = () => {
    setEditor({ mode: "create", originalId: null });
    resetDraft();
    setFormError(null);
  };

  const openEditEditor = (session: SessionConfig) => {
    onSelect(session.id);
    setEditor({ mode: "edit", originalId: session.id });
    loadDraft(session);
    setFormError(null);
  };

  const closeEditor = () => {
    setEditor(null);
  };

  const handleSessionSubmit = async () => {
    if (!editor) {
      return;
    }

    setFormError(null);
    const validationError = validateSessionDraft(draft);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const existingSession =
      editor.mode === "edit"
        ? sessions.find((session) => session.id === editor.originalId)
        : null;
    const nextSession = sessionFromDraft(draft, existingSession?.prompts ?? []);

    setSaving(true);
    try {
      if (editor.mode === "create") {
        await onCreateSession(nextSession);
      } else {
        await onEditSession(editor.originalId ?? nextSession.id, {
          id: nextSession.id,
          name: nextSession.name,
          cwd: nextSession.cwd,
          prompts: nextSession.prompts,
        });
      }
      closeEditor();
    } catch (error) {
      setFormError(messageFromError(error, "Failed to save session"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSession = async (session: SessionConfig) => {
    const confirmed = window.confirm(
      `Delete session "${session.name}"? Running processes will be stopped.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingSessionId(session.id);
    setFormError(null);
    try {
      await onDeleteSession(session.id);
      if (editor?.originalId === session.id) {
        closeEditor();
      }
    } catch (error) {
      setFormError(messageFromError(error, "Failed to delete session"));
    } finally {
      setDeletingSessionId(null);
    }
  };

  if (collapsed) {
    return (
      <aside aria-label="Sessions" className="session-panel panel-collapsed">
        <button
          aria-expanded={false}
          aria-label="Show sessions panel"
          className="panel-rail-button"
          onClick={onToggleCollapsed}
          type="button"
        >
          <span className="panel-rail-title">Sessions</span>
          <span className="panel-rail-action">Show</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="session-panel" aria-label="Sessions">
      <div className="panel-header">
        <div>
          <p className="eyebrow">TermRail</p>
          <h1>Sessions</h1>
        </div>
        <button
          aria-expanded={true}
          aria-label="Hide sessions panel"
          className="ghost-button compact collapse-button"
          onClick={onToggleCollapsed}
          type="button"
        >
          {"<"}
        </button>
      </div>

      <div className="panel-toolbar">
        <button
          className="ghost-button"
          disabled={loading}
          onClick={onRefresh}
          type="button"
        >
          Refresh
        </button>
        <button
          className="primary-button"
          onClick={openCreateEditor}
          type="button"
        >
          Add
        </button>
      </div>

      <div className="activity-box" aria-live="polite">
        <div className="activity-header">
          <span className="activity-title">Activity</span>
          <span className="activity-count">{activitySummary}</span>
        </div>
        {sortedActivityItems.length > 0 ? (
          <div className="activity-list">
            {sortedActivityItems.map(({ activity, session }) => (
              <button
                className={`activity-item ${activity.state}`}
                key={session.id}
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className="activity-item-main">
                  <span className="activity-item-name">{session.name}</span>
                  <span className="activity-item-detail">
                    {outputActivityDetail(activity)}
                  </span>
                </span>
                <span className={`activity-state ${activity.state}`}>
                  {outputActivityLabel(activity.state)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="activity-empty">No paused output.</p>
        )}
      </div>

      {editor ? (
        <SessionForm
          draft={draft}
          editor={editor}
          error={formError}
          key={`${editor.mode}:${editor.originalId ?? "new"}`}
          onChange={updateDraft}
          onClose={closeEditor}
          onSubmit={handleSessionSubmit}
          saving={saving}
        />
      ) : null}

      {(formError || error) && !editor ? (
        <div className="form-error">{formError ?? error}</div>
      ) : null}

      <div className="session-list">
        {loading ? <p className="empty-state">Loading sessions...</p> : null}
        {!loading && sessions.length === 0 ? (
          <p className="empty-state">No configured sessions.</p>
        ) : null}
        {sessions.map((session) => {
          const terminalId =
            activeTerminalIds[session.id] ?? session.terminals[0]?.id ?? null;
          const terminalStatus = terminalId
            ? terminalStatuses[session.id]?.[terminalId]
            : undefined;
          const isSelected = session.id === selectedSessionId;
          const isRunning = terminalStatus?.state === "running";
          const isBusy = terminalId
            ? actionTerminalKey === terminalActionKey(session.id, terminalId)
            : false;
          const isDeleting = deletingSessionId === session.id;
          const activity = outputActivities[session.id];

          return (
            <section
              className={`session-item${isSelected ? " selected" : ""}`}
              key={session.id}
            >
              <button
                className="session-select"
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className="session-title-row">
                  <span className="session-heading">
                    <span className="session-name" title={session.name}>
                      {session.name}
                    </span>
                    <span
                      aria-hidden={activity ? undefined : true}
                      aria-label={
                        activity
                          ? `${outputActivityLabel(
                              activity.state,
                            )}: ${outputActivityDetail(activity)}`
                          : undefined
                      }
                      className={`activity-badge ${activity?.state ?? "empty"}`}
                    >
                      {activity
                        ? outputActivityLabel(activity.state)
                        : "Working"}
                    </span>
                  </span>
                  <span className={`status-pill ${isRunning ? "run" : "stop"}`}>
                    {terminalId ? statusLabel(terminalStatus) : "No terminal"}
                  </span>
                </span>
                <span className="session-meta" title={session.cwd}>
                  {session.cwd}
                </span>
              </button>
              <div className="session-actions">
                <button
                  disabled={!terminalId || isRunning || isBusy || isDeleting}
                  onClick={() =>
                    terminalId ? onStart(session.id, terminalId) : undefined
                  }
                  type="button"
                >
                  Start
                </button>
                <button
                  disabled={!terminalId || !isRunning || isBusy || isDeleting}
                  onClick={() =>
                    terminalId ? onStop(session.id, terminalId) : undefined
                  }
                  type="button"
                >
                  Stop
                </button>
                <button
                  disabled={isDeleting}
                  onClick={() => openEditEditor(session)}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="danger-button"
                  disabled={isDeleting}
                  onClick={() => void handleDeleteSession(session)}
                  type="button"
                >
                  {isDeleting ? "Deleting" : "Delete"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
