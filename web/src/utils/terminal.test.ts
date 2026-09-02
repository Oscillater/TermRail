import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { focusTerminalPreventScroll } from "./terminal";

afterEach(() => {
  document.body.replaceChildren();
});

describe("focusTerminalPreventScroll", () => {
  it("focuses the xterm textarea without scrolling the page", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const focus = vi.spyOn(textarea, "focus");
    const terminal = { textarea } as unknown as Terminal;

    expect(focusTerminalPreventScroll(terminal)).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("reports failure when the textarea cannot receive focus", () => {
    const textarea = document.createElement("textarea");
    const terminal = { textarea } as unknown as Terminal;

    expect(focusTerminalPreventScroll(terminal)).toBe(false);
  });
});
