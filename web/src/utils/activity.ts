import type {
  OutputActivities,
  OutputActivity,
  OutputActivityState,
  PromptExample,
  RuntimeStatus,
  SessionConfig,
  SessionAttention,
  SessionAttentionById,
  TerminalAttention,
  TerminalAttentionBySession,
} from "../types";

export const outputQuietDelayMs = 3_000;
export const statusRefreshIntervalMs = 2_000;

export function defaultRuntimeStatus(
  sessionId: string,
  terminalId?: string,
): RuntimeStatus {
  return {
    sessionId,
    ...(terminalId ? { terminalId } : {}),
    runtimeId: null,
    state: "stopped",
    startedAt: null,
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: null,
    bufferLength: 0,
  };
}

export function collectSessionPrompts(
  sessions: SessionConfig[],
): PromptExample[] {
  const prompts: PromptExample[] = [];
  const seen = new Set<string>();

  sessions.forEach((session) => {
    session.prompts.forEach((prompt) => {
      if (seen.has(prompt.id)) {
        return;
      }
      seen.add(prompt.id);
      prompts.push({ ...prompt });
    });
  });

  return prompts;
}

export function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function timestampFromIso(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestIso(left: string | null, right: string | null): string | null {
  const leftTimestamp = timestampFromIso(left);
  const rightTimestamp = timestampFromIso(right);

  if (leftTimestamp === null) {
    return right;
  }
  if (rightTimestamp === null) {
    return left;
  }

  return leftTimestamp > rightTimestamp ? left : right;
}

export function aggregateSessionStatus(
  session: SessionConfig,
  terminalStatuses: Record<string, RuntimeStatus> | undefined,
): RuntimeStatus {
  const statuses = session.terminals.map(
    (terminal) =>
      terminalStatuses?.[terminal.id] ??
      defaultRuntimeStatus(session.id, terminal.id),
  );
  const runningStatuses = statuses.filter(
    (status) => status.state === "running",
  );
  const candidates = runningStatuses.length > 0 ? runningStatuses : statuses;
  const newest = [...candidates].sort(
    (left, right) =>
      (timestampFromIso(right.lastOutputAt) ?? 0) -
        (timestampFromIso(left.lastOutputAt) ?? 0) ||
      (timestampFromIso(right.stoppedAt) ?? 0) -
        (timestampFromIso(left.stoppedAt) ?? 0) ||
      (timestampFromIso(right.startedAt) ?? 0) -
        (timestampFromIso(left.startedAt) ?? 0),
  )[0];

  return {
    sessionId: session.id,
    runtimeId: runningStatuses[0]?.runtimeId ?? newest?.runtimeId ?? null,
    state: runningStatuses.length > 0 ? "running" : "stopped",
    startedAt: newest?.startedAt ?? null,
    stoppedAt: runningStatuses.length > 0 ? null : (newest?.stoppedAt ?? null),
    lastOutputAt: statuses.reduce<string | null>(
      (latest, status) => latestIso(latest, status.lastOutputAt),
      null,
    ),
    exitCode: runningStatuses.length > 0 ? null : (newest?.exitCode ?? null),
    pid: runningStatuses[0]?.pid ?? null,
    bufferLength: statuses.reduce(
      (total, status) => total + status.bufferLength,
      0,
    ),
  };
}

export function mergeRuntimeStatus(
  current: RuntimeStatus | undefined,
  incoming: RuntimeStatus,
): RuntimeStatus {
  if (!current || current.startedAt !== incoming.startedAt) {
    return incoming;
  }

  const merged = {
    ...incoming,
    lastOutputAt: latestIso(current.lastOutputAt, incoming.lastOutputAt),
  };

  const currentStoppedAt = timestampFromIso(current.stoppedAt);
  const incomingLastOutputAt = timestampFromIso(incoming.lastOutputAt);
  if (
    current.state === "stopped" &&
    incoming.state === "running" &&
    currentStoppedAt !== null &&
    (incomingLastOutputAt === null || currentStoppedAt >= incomingLastOutputAt)
  ) {
    return {
      ...merged,
      state: "stopped",
      stoppedAt: current.stoppedAt,
      exitCode: current.exitCode,
      pid: null,
    };
  }

  return merged;
}

export function activityFromStatus(
  status: RuntimeStatus | undefined,
  acknowledgedAt: number,
  now: number,
): OutputActivity | undefined {
  if (!status) {
    return undefined;
  }

  if (status.state === "stopped") {
    const stoppedAt = timestampFromIso(status.stoppedAt);
    if (stoppedAt !== null && stoppedAt > acknowledgedAt) {
      return { state: "stopped", updatedAt: stoppedAt };
    }
    return undefined;
  }

  const lastOutputAt = timestampFromIso(status.lastOutputAt);
  if (lastOutputAt === null || lastOutputAt <= acknowledgedAt) {
    return undefined;
  }

  return {
    state: now - lastOutputAt >= outputQuietDelayMs ? "quiet" : "working",
    updatedAt: lastOutputAt,
  };
}

export function collectOutputActivities(
  sessions: SessionConfig[],
  statuses: Record<string, RuntimeStatus>,
  activityAcknowledgedAt: Record<string, number>,
  activityNow: number,
): OutputActivities {
  const next: OutputActivities = {};
  sessions.forEach((session) => {
    const activity = activityFromStatus(
      statuses[session.id],
      activityAcknowledgedAt[session.id] ?? 0,
      activityNow,
    );
    if (activity) {
      next[session.id] = activity;
    }
  });
  return next;
}

export function terminalAttentionKey(
  sessionId: string,
  terminalId: string,
): string {
  return `${sessionId}/${terminalId}`;
}

function timestampOrZero(value: string | null): number {
  return timestampFromIso(value) ?? 0;
}

export function terminalAttentionFromStatus(
  status: RuntimeStatus | undefined,
  readAt: number,
  now: number,
): TerminalAttention {
  if (!status) {
    return { state: "idle", unread: false, updatedAt: 0 };
  }

  const lastOutputAt = timestampOrZero(status.lastOutputAt);
  const stoppedAt = timestampOrZero(status.stoppedAt);
  const startedAt = timestampOrZero(status.startedAt);

  if (status.state === "stopped") {
    const updatedAt = Math.max(stoppedAt, lastOutputAt);
    if (updatedAt === 0) {
      return { state: "idle", unread: false, updatedAt: 0 };
    }

    const unread = updatedAt > readAt;
    return {
      state: unread ? "done" : "stopped",
      unread,
      updatedAt,
    };
  }

  if (lastOutputAt === 0) {
    return {
      state: "running",
      unread: false,
      updatedAt: startedAt,
    };
  }

  const ready = now - lastOutputAt >= outputQuietDelayMs;
  return {
    state: ready ? "ready" : "working",
    unread: ready && lastOutputAt > readAt,
    updatedAt: lastOutputAt,
  };
}

export function collectTerminalAttention(
  sessions: SessionConfig[],
  terminalStatuses: Record<string, Record<string, RuntimeStatus>>,
  terminalReadAt: Record<string, number>,
  now: number,
): TerminalAttentionBySession {
  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      Object.fromEntries(
        session.terminals.map((terminal) => {
          const status =
            terminalStatuses[session.id]?.[terminal.id] ??
            defaultRuntimeStatus(session.id, terminal.id);
          const readAt =
            terminalReadAt[terminalAttentionKey(session.id, terminal.id)] ?? 0;

          return [
            terminal.id,
            terminalAttentionFromStatus(status, readAt, now),
          ];
        }),
      ),
    ]),
  );
}

export function summarizeSessionAttention(
  session: SessionConfig,
  terminalAttention: Record<string, TerminalAttention> | undefined,
): SessionAttention {
  return session.terminals.reduce<SessionAttention>(
    (summary, terminal) => {
      const attention = terminalAttention?.[terminal.id] ?? {
        state: "idle" as const,
        unread: false,
        updatedAt: 0,
      };

      summary.updatedAt = Math.max(summary.updatedAt, attention.updatedAt);
      if (attention.unread) {
        summary.unreadCount += 1;
      }

      switch (attention.state) {
        case "done":
          summary.unreadDoneCount += attention.unread ? 1 : 0;
          summary.stoppedCount += 1;
          break;
        case "ready":
          summary.readyCount += 1;
          summary.unreadReadyCount += attention.unread ? 1 : 0;
          break;
        case "working":
          summary.workingCount += 1;
          break;
        case "running":
          summary.runningCount += 1;
          break;
        case "stopped":
          summary.stoppedCount += 1;
          break;
        case "idle":
          break;
      }

      return summary;
    },
    {
      terminalCount: session.terminals.length,
      unreadCount: 0,
      unreadReadyCount: 0,
      unreadDoneCount: 0,
      readyCount: 0,
      workingCount: 0,
      runningCount: 0,
      stoppedCount: 0,
      updatedAt: 0,
    },
  );
}

export function collectSessionAttention(
  sessions: SessionConfig[],
  terminalAttention: TerminalAttentionBySession,
): SessionAttentionById {
  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      summarizeSessionAttention(session, terminalAttention[session.id]),
    ]),
  );
}

export function statusLabel(status: RuntimeStatus | undefined): string {
  return status?.state === "running" ? "Running" : "Stopped";
}

export function outputActivityLabel(state: OutputActivityState): string {
  switch (state) {
    case "running":
      return "Running";
    case "working":
      return "Working";
    case "quiet":
      return "Quiet";
    case "stopped":
      return "Stopped";
  }
}

export function outputActivityDetail(activity: OutputActivity): string {
  switch (activity.state) {
    case "running":
      return "Process running";
    case "working":
      return "Output is streaming";
    case "quiet":
      return "Output paused";
    case "stopped":
      return "Process stopped";
  }
}

export function activitySortValue(state: OutputActivityState): number {
  switch (state) {
    case "quiet":
      return 0;
    case "stopped":
      return 1;
    case "working":
      return 2;
    case "running":
      return 3;
  }
}

export function terminalAttentionLabel(
  attention: TerminalAttention | undefined,
): string {
  switch (attention?.state) {
    case "done":
      return "Done";
    case "ready":
      return "Ready";
    case "working":
      return "Working";
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "idle":
    case undefined:
      return "";
  }
}

function plural(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function sessionAttentionLabel(
  attention: SessionAttention | undefined,
): string {
  if (!attention || attention.terminalCount === 0) {
    return "";
  }
  if (attention.unreadReadyCount > 0 && attention.unreadDoneCount > 0) {
    return `${attention.unreadCount} Ready`;
  }
  if (attention.unreadReadyCount > 0) {
    return `${attention.unreadReadyCount} Ready`;
  }
  if (attention.unreadDoneCount > 0) {
    return `${attention.unreadDoneCount} Done`;
  }
  if (attention.readyCount > 0) {
    return "Ready";
  }
  if (attention.workingCount > 0) {
    return "Working";
  }
  if (attention.runningCount > 0) {
    return "Running";
  }
  return "";
}

export function sessionAttentionDetail(
  attention: SessionAttention | undefined,
): string {
  if (!attention || attention.terminalCount === 0) {
    return "No terminal tabs";
  }
  if (attention.unreadReadyCount > 0 && attention.unreadDoneCount > 0) {
    return `${plural(attention.unreadCount, "terminal")} need review`;
  }
  if (attention.unreadReadyCount > 0) {
    return `${plural(attention.unreadReadyCount, "terminal")} ready`;
  }
  if (attention.unreadDoneCount > 0) {
    return `${plural(attention.unreadDoneCount, "terminal")} done`;
  }
  if (attention.readyCount > 0) {
    return `${plural(attention.readyCount, "terminal")} ready`;
  }
  if (attention.workingCount > 0) {
    return "Output is streaming";
  }
  if (attention.runningCount > 0) {
    return "Process running";
  }
  return "No unread output";
}

export function sessionAttentionSortValue(
  attention: SessionAttention | undefined,
): number {
  if (!attention) {
    return 5;
  }
  if (attention.unreadCount > 0) {
    return 0;
  }
  if (attention.readyCount > 0) {
    return 1;
  }
  if (attention.workingCount > 0) {
    return 2;
  }
  if (attention.runningCount > 0) {
    return 3;
  }
  return 4;
}
