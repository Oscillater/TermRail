import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalStream } from "../terminalStream";
import type { RuntimeStatus, TerminalTarget } from "../types";
import { useSessionStream } from "./useSessionStream";

type SocketEventType = "close" | "error" | "message" | "open";
type SocketListener = (event: Event | MessageEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: SocketEventType, listener: SocketListener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  receive(message: unknown): void {
    this.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  private emit(type: SocketEventType, event: Event | MessageEvent): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

const terminal1 = { sessionId: "session", terminalId: "terminal-1" };
const terminal2 = { sessionId: "session", terminalId: "terminal-2" };

function runtimeStatus(target: TerminalTarget): RuntimeStatus {
  return {
    sessionId: target.sessionId,
    terminalId: target.terminalId,
    runtimeId: 1,
    state: "running",
    startedAt: "2026-09-03T00:00:00.000Z",
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: 123,
    bufferLength: 0,
  };
}

function messages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message));
}

function renderStream(targets: TerminalTarget[], active = terminal1) {
  const terminalStream = createTerminalStream();
  const handlers = {
    onConfigStale: vi.fn(),
    onError: vi.fn(),
    onOutput: vi.fn(),
    onSessionStatus: vi.fn(),
    onTerminalStatus: vi.fn(),
  };
  const result = renderHook(
    ({ activeTerminal, terminalTargets }) =>
      useSessionStream({
        activeTerminal,
        ...handlers,
        terminalStream,
        terminalTargets,
      }),
    { initialProps: { activeTerminal: active, terminalTargets: targets } },
  );
  return { ...result, handlers, terminalStream };
}

describe("useSessionStream", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates terminal subscriptions without rebuilding the socket", () => {
    const { rerender, result, unmount } = renderStream([terminal1, terminal2]);
    const socket = FakeWebSocket.instances[0];

    act(() => socket.open());
    expect(messages(socket)).toEqual([
      { type: "subscribe", ...terminal1 },
      { type: "subscribe", ...terminal2 },
    ]);

    rerender({ activeTerminal: terminal1, terminalTargets: [terminal1] });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(result.current.connectionState).toBe("connected");
    expect(messages(socket).at(-1)).toEqual({
      type: "unsubscribe",
      ...terminal2,
    });

    unmount();
  });

  it("publishes only the latest snapshot request for a terminal", () => {
    const { result, terminalStream, unmount } = renderStream([terminal1]);
    const socket = FakeWebSocket.instances[0];
    const snapshots: Array<{ requestId: string }> = [];
    const unsubscribe = terminalStream.subscribe(terminal1, (event) => {
      if (event.type === "snapshot") {
        snapshots.push(event);
      }
    });

    act(() => socket.open());
    let firstRequestId: string | null = null;
    let secondRequestId: string | null = null;
    act(() => {
      firstRequestId = result.current.requestSnapshot(
        terminal1.sessionId,
        terminal1.terminalId,
        120,
        40,
      );
      secondRequestId = result.current.requestSnapshot(
        terminal1.sessionId,
        terminal1.terminalId,
        120,
        40,
      );
    });

    const snapshotMessage = (requestId: string) => ({
      type: "terminal.snapshot",
      requestId,
      ...terminal1,
      status: runtimeStatus(terminal1),
      runtimeId: 1,
      format: "xterm-serialized-vt",
      mode: "full",
      data: "ready",
      seq: 4,
      minSeq: null,
      complete: true,
      cols: 120,
      rows: 40,
      screenRevision: 2,
      bufferType: "normal",
    });

    act(() => socket.receive(snapshotMessage(firstRequestId!)));
    expect(snapshots).toEqual([]);

    act(() => socket.receive(snapshotMessage(secondRequestId!)));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.requestId).toBe(secondRequestId);

    unsubscribe();
    unmount();
  });

  it("reconnects only after the socket actually closes", () => {
    vi.useFakeTimers();
    const { unmount } = renderStream([terminal1, terminal2]);
    const firstSocket = FakeWebSocket.instances[0];

    act(() => firstSocket.open());
    act(() => firstSocket.close());
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeWebSocket.instances).toHaveLength(2);

    const secondSocket = FakeWebSocket.instances[1];
    act(() => secondSocket.open());
    expect(messages(secondSocket)).toEqual([
      { type: "subscribe", ...terminal1 },
      { type: "subscribe", ...terminal2 },
    ]);

    unmount();
  });
});
