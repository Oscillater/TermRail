import { Terminal } from "@xterm/xterm";
import { terminalSizeLimits } from "@termrail/shared";
import type { TerminalScrollState } from "../types";

export function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clampTerminalSize(cols: number, rows: number) {
  return {
    cols: clampValue(
      cols,
      terminalSizeLimits.minCols,
      terminalSizeLimits.maxCols,
    ),
    rows: clampValue(
      rows,
      terminalSizeLimits.minRows,
      terminalSizeLimits.maxRows,
    ),
  };
}

export function readTerminalScrollState(
  terminal: Terminal | null,
): TerminalScrollState {
  if (!terminal) {
    return { viewportY: 0, baseY: 0 };
  }

  const buffer = terminal.buffer.active;
  const baseY = Math.max(0, buffer.baseY);
  return {
    baseY,
    viewportY: clampValue(buffer.viewportY, 0, baseY),
  };
}

export function snapTerminalViewportToBottom(terminal: Terminal): void {
  terminal.scrollToBottom();
  // scrollToBottom() is a no-op once the buffer reports the bottom, so the
  // viewport element can stay stuck at a stale offset after a snapshot replay
  // or reconnect. Push the element down directly; xterm's own scroll handler
  // reconciles the buffer, which is already at the bottom.
  const viewport = terminal.element?.querySelector(".xterm-viewport");
  if (viewport instanceof HTMLElement) {
    viewport.scrollTop = viewport.scrollHeight;
  }
}

export function focusTerminalPreventScroll(terminal: Terminal): boolean {
  const textarea = terminal.textarea;
  if (textarea) {
    textarea.focus({ preventScroll: true });
    return document.activeElement === textarea;
  }

  terminal.focus();
  return Boolean(
    terminal.textarea && document.activeElement === terminal.textarea,
  );
}
