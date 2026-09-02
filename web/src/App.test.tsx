import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalFocusRequest } from "./types";

const mocks = vi.hoisted(() => ({
  runTerminalAction: vi.fn(),
  selectTerminal: vi.fn(),
  useAppController: vi.fn(),
}));

vi.mock("./useAppController", () => ({
  useAppController: mocks.useAppController,
}));

vi.mock("./components/SessionPanel", () => ({
  SessionPanel: ({
    onStart,
  }: {
    onStart: (sessionId: string, terminalId: string) => void;
  }) => (
    <button onClick={() => onStart("session-a", "terminal-a")} type="button">
      Start session
    </button>
  ),
}));

vi.mock("./components/TerminalPane", () => ({
  TerminalPane: ({
    focusRequest,
  }: {
    focusRequest: TerminalFocusRequest | null;
  }) => (
    <output data-testid="focus-request">
      {focusRequest ? JSON.stringify(focusRequest) : "none"}
    </output>
  ),
}));

vi.mock("./components/PromptPanel", () => ({
  PromptPanel: () => null,
}));

import { App } from "./App";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.useAppController.mockReturnValue({
    actionTerminalKey: null,
    activeTerminalIds: { "session-a": "terminal-a" },
    createSession: vi.fn(),
    createTerminal: vi.fn(),
    deleteSession: vi.fn(),
    deleteTerminal: vi.fn(),
    loadSessions: vi.fn(),
    loading: false,
    markVisibleTerminalOutputApplied: vi.fn(),
    promptError: null,
    prompts: [],
    promptsLoaded: true,
    requestTerminalInput: vi.fn(),
    requestTerminalSnapshot: vi.fn(),
    runTerminalAction: mocks.runTerminalAction,
    selectedSession: null,
    selectedSessionId: "session-a",
    selectedTerminal: null,
    selectedTerminalAttention: {},
    selectedTerminalStatus: undefined,
    selectedTerminalStatuses: {},
    selectSession: vi.fn(),
    selectTerminal: mocks.selectTerminal,
    sendTerminalInput: vi.fn(),
    sendTerminalResize: vi.fn(),
    sessionAttention: {},
    sessionError: null,
    sessions: [
      {
        id: "session-a",
        name: "Session A",
        cwd: ".",
        prompts: [],
        terminals: [
          { id: "terminal-a", name: "Terminal A", command: "codex resume" },
        ],
      },
    ],
    setTerminalError: vi.fn(),
    setTerminalSize: vi.fn(),
    streamConnectionState: "connected",
    terminalError: null,
    terminalInputRequest: null,
    terminalStatuses: {},
    terminalStream: {},
    updatePrompts: vi.fn(),
    updateSession: vi.fn(),
    updateTerminal: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe("terminal focus requests", () => {
  it("requests terminal focus immediately and again after Start settles", async () => {
    const start = deferred<unknown>();
    mocks.runTerminalAction.mockReturnValue(start.promise);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    expect(mocks.selectTerminal).toHaveBeenCalledWith(
      "session-a",
      "terminal-a",
    );
    expect(mocks.runTerminalAction).toHaveBeenCalledWith(
      "session-a",
      "terminal-a",
      "start",
    );
    expect(screen.getByTestId("focus-request").textContent).toBe(
      JSON.stringify({
        id: 1,
        sessionId: "session-a",
        terminalId: "terminal-a",
      }),
    );

    await act(async () => {
      start.resolve(undefined);
      await start.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("focus-request").textContent).toBe(
        JSON.stringify({
          id: 2,
          sessionId: "session-a",
          terminalId: "terminal-a",
        }),
      );
    });
  });
});
