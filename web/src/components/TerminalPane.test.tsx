import { forwardRef, useImperativeHandle, type ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./TerminalViewport", () => ({
  TerminalViewport: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      fit: vi.fn(),
      focus: vi.fn(),
    }));
    return <div data-testid="terminal-viewport" />;
  }),
}));

import { TerminalPane } from "./TerminalPane";

type TerminalPaneProps = ComponentProps<typeof TerminalPane>;

afterEach(() => {
  cleanup();
});

function terminalPaneProps(
  overrides: Partial<TerminalPaneProps> = {},
): TerminalPaneProps {
  return {
    actionTerminalKey: null,
    connectionState: "connected",
    error: null,
    focusRequest: null,
    inputRequest: null,
    onCreateTerminal: vi.fn(),
    onDeleteTerminal: vi.fn(),
    onError: vi.fn(),
    onFocusRequest: vi.fn(),
    onInput: vi.fn(),
    onResize: vi.fn(),
    onSelectTerminal: vi.fn(),
    onSize: vi.fn(),
    onSnapshotRequest: vi.fn(),
    onStartTerminal: vi.fn(),
    onStopTerminal: vi.fn(),
    onUpdateTerminal: vi.fn(),
    onVisibleOutputApplied: vi.fn(),
    session: {
      id: "session-a",
      name: "Session A",
      cwd: ".",
      prompts: [],
      terminals: [],
    },
    status: undefined,
    terminal: null,
    terminalAttention: {},
    terminalStatuses: {},
    terminalStream: {
      publish: vi.fn(),
      subscribe: vi.fn(),
    },
    ...overrides,
  };
}

describe("TerminalPane", () => {
  it("creates a terminal when the command is empty", async () => {
    const onCreateTerminal = vi.fn().mockResolvedValue({
      id: "terminal-a",
      name: "Terminal 1",
      command: "",
    });
    render(<TerminalPane {...terminalPaneProps({ onCreateTerminal })} />);

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreateTerminal).toHaveBeenCalledWith("session-a", {
        name: "Terminal 1",
        command: "",
      });
    });
  });
});
