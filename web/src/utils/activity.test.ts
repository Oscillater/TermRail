import { describe, expect, it } from "vitest";
import type { RuntimeStatus, SessionConfig } from "../types";
import {
  outputQuietDelayMs,
  summarizeSessionAttention,
  terminalAttentionFromStatus,
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
    ).toEqual({ state: "ready", unread: false, updatedAt: readyAt });
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
});
