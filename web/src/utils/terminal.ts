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

export function focusTerminalPreventScroll(terminal: Terminal): void {
  const textarea = terminal.textarea;
  if (textarea) {
    textarea.focus({ preventScroll: true });
    return;
  }

  terminal.focus();
}
