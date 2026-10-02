import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalScroll } from "./useTerminalScroll";

afterEach(() => {
  cleanup();
});

type FakeTerminal = {
  buffer: { active: { baseY: number; viewportY: number } };
  rows: number;
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
};

function createFakeTerminal(): FakeTerminal {
  const terminal: FakeTerminal = {
    buffer: { active: { baseY: 50, viewportY: 10 } },
    rows: 24,
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
  };
  terminal.scrollToBottom.mockImplementation(() => {
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY;
  });
  return terminal;
}

function Harness({ terminal }: { terminal: FakeTerminal }) {
  const terminalRef = useRef<Terminal | null>(terminal as unknown as Terminal);
  const { scrollState, scrollTerminalToBottom } =
    useTerminalScroll(terminalRef);

  return (
    <div>
      <button onClick={() => scrollTerminalToBottom()} type="button">
        Scroll to bottom
      </button>
      <input aria-label="Session name" />
      <output data-testid="viewport-y">{scrollState.viewportY}</output>
    </div>
  );
}

describe("useTerminalScroll global shortcut", () => {
  it("scrolls to the bottom when Ctrl+End is pressed outside a text field", () => {
    const terminal = createFakeTerminal();
    render(<Harness terminal={terminal} />);

    fireEvent.keyDown(document.body, { ctrlKey: true, key: "End" });

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("viewport-y").textContent).toBe("50");
  });

  it("leaves Ctrl+End to the field while a text field has focus", () => {
    const terminal = createFakeTerminal();
    render(<Harness terminal={terminal} />);

    fireEvent.keyDown(screen.getByLabelText("Session name"), {
      ctrlKey: true,
      key: "End",
    });

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(screen.getByTestId("viewport-y").textContent).toBe("0");
  });

  it("ignores keys that are not the shortcut", () => {
    const terminal = createFakeTerminal();
    render(<Harness terminal={terminal} />);

    fireEvent.keyDown(document.body, { key: "End" });

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("stops listening once the terminal view unmounts", () => {
    const terminal = createFakeTerminal();
    const view = render(<Harness terminal={terminal} />);

    view.unmount();
    fireEvent.keyDown(document.body, { ctrlKey: true, key: "End" });

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });
});
