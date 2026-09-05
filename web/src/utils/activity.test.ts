import { describe, expect, it } from "vitest";
import type { RuntimeStatus, SessionConfig } from "../types";
import {
  collectTerminalAttention,
  outputQuietDelayMs,
  sortSessionsByAttentionState,
  summarizeSessionAttention,
  terminalAttentionFromStatus,
  terminalAttentionKey,
} from "./activity";

const now = Date.parse("2026-01-01T00:00:10.000Z");

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function runtimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    sessionId: "session-a",
    terminalId: "terminal-a",
    runtimeId: 1,
    state: "running",
    startedAt: iso(now - 10_000),
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: 42,
    bufferLength: 0,
    ...overrides,
  };
}

describe("terminal attention", () => {
  it("distinguishes running, working, and ready terminals", () => {
    expect(terminalAttentionFromStatus(runtimeStatus(), 0, now).state).toBe(
      "running",
    );

    const workingAt = now - outputQuietDelayMs + 1;
    expect(
      terminalAttentionFromStatus(
        runtimeStatus({ lastOutputAt: iso(workingAt) }),
        0,
        now,
      ),
    ).toEqual({ state: "working", unread: false, updatedAt: workingAt });

    const readyAt = now - outputQuietDelayMs;
    expect(
      terminalAttentionFromStatus(
        runtimeStatus({ lastOutputAt: iso(readyAt) }),
        readyAt - 1,
        now,
      ),
    ).toEqual({ state: "ready", unread: true, updatedAt: readyAt });
  });

  it("clears ready attention once the output timestamp is read", () => {
    const readyAt = now - outputQuietDelayMs;
    expect(
      terminalAttentionFromStatus(
        runtimeStatus({ lastOutputAt: iso(readyAt) }),
        readyAt,
        now,
      ),
    ).toEqual({ state: "running", unread: false, updatedAt: readyAt });
  });

  it("creates a new ready state only after newer output becomes quiet", () => {
    const readAt = now - 5_000;
    const nextOutputAt = now - 1_000;
    const status = runtimeStatus({ lastOutputAt: iso(nextOutputAt) });

    expect(terminalAttentionFromStatus(status, readAt, now)).toEqual({
      state: "working",
      unread: false,
      updatedAt: nextOutputAt,
    });
    expect(
      terminalAttentionFromStatus(
        status,
        readAt,
        nextOutputAt + outputQuietDelayMs,
      ),
    ).toEqual({
      state: "ready",
      unread: true,
      updatedAt: nextOutputAt,
    });
  });

  it("marks a stopped terminal done until its final state is read", () => {
    const stoppedAt = now - 500;
    const stopped = runtimeStatus({
      state: "stopped",
      stoppedAt: iso(stoppedAt),
      lastOutputAt: iso(stoppedAt - 100),
      exitCode: 0,
      pid: null,
    });

    expect(terminalAttentionFromStatus(stopped, stoppedAt - 1, now)).toEqual({
      state: "done",
      unread: true,
      updatedAt: stoppedAt,
    });
    expect(terminalAttentionFromStatus(stopped, stoppedAt, now)).toEqual({
      state: "stopped",
      unread: false,
      updatedAt: stoppedAt,
    });
  });

  it("summarizes unread ready and done terminals at session level", () => {
    const session: SessionConfig = {
      id: "session-a",
      name: "Session A",
      cwd: ".",
      prompts: [],
      terminals: [
        { id: "terminal-a", name: "A", command: "a" },
        { id: "terminal-b", name: "B", command: "b" },
        { id: "terminal-c", name: "C", command: "c" },
      ],
    };

    expect(
      summarizeSessionAttention(session, {
        "terminal-a": { state: "ready", unread: true, updatedAt: 10 },
        "terminal-b": { state: "done", unread: true, updatedAt: 20 },
        "terminal-c": { state: "working", unread: false, updatedAt: 30 },
      }),
    ).toEqual({
      terminalCount: 3,
      unreadCount: 2,
      unreadReadyCount: 1,
      unreadDoneCount: 1,
      readyCount: 1,
      workingCount: 1,
      runningCount: 0,
      stoppedCount: 1,
      updatedAt: 30,
    });
  });

  it("keeps unread state separate for each terminal", () => {
    const outputAt = now - outputQuietDelayMs;
    const session: SessionConfig = {
      id: "session-a",
      name: "Session A",
      cwd: ".",
      prompts: [],
      terminals: [
        { id: "terminal-a", name: "A", command: "a" },
        { id: "terminal-b", name: "B", command: "b" },
      ],
    };
    const statusA = runtimeStatus({ lastOutputAt: iso(outputAt) });
    const statusB = runtimeStatus({
      terminalId: "terminal-b",
      lastOutputAt: iso(outputAt),
    });

    expect(
      collectTerminalAttention(
        [session],
        { "session-a": { "terminal-a": statusA, "terminal-b": statusB } },
        { [terminalAttentionKey("session-a", "terminal-a")]: outputAt },
        now,
      )["session-a"],
    ).toEqual({
      "terminal-a": {
        state: "running",
        unread: false,
        updatedAt: outputAt,
      },
      "terminal-b": {
        state: "ready",
        unread: true,
        updatedAt: outputAt,
      },
    });
  });
});

describe("session list ordering", () => {
  const sessions: SessionConfig[] = ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    name: id.toUpperCase(),
    cwd: ".",
    prompts: [],
    terminals: [],
  }));

  it("moves ready sessions first and working sessions second", () => {
    const emptySummary = {
      terminalCount: 1,
      unreadCount: 0,
      unreadReadyCount: 0,
      unreadDoneCount: 0,
      readyCount: 0,
      workingCount: 0,
      runningCount: 1,
      stoppedCount: 0,
      updatedAt: 0,
    };

    expect(
      sortSessionsByAttentionState(sessions, {
        a: emptySummary,
        b: { ...emptySummary, workingCount: 1, runningCount: 0 },
        c: {
          ...emptySummary,
          unreadCount: 1,
          unreadReadyCount: 1,
          readyCount: 1,
          runningCount: 0,
        },
        d: { ...emptySummary, workingCount: 1, runningCount: 0 },
        e: {
          ...emptySummary,
          unreadCount: 1,
          unreadReadyCount: 1,
          readyCount: 1,
          runningCount: 0,
        },
      }).map((session) => session.id),
    ).toEqual(["c", "e", "b", "d", "a"]);
  });

  it("keeps configuration order when no session needs attention", () => {
    expect(
      sortSessionsByAttentionState(sessions, {}).map(({ id }) => id),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });
});
