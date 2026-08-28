import type {
  OutputActivities,
  OutputActivity,
  OutputActivityState,
  PromptExample,
  RuntimeStatus,
  SessionConfig,
} from "../types";

export const outputQuietDelayMs = 3_000;
export const statusRefreshIntervalMs = 2_000;

export function defaultRuntimeStatus(sessionId: string): RuntimeStatus {
  return {
    sessionId,
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
