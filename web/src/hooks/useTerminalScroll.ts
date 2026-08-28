import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import type { TerminalScrollState } from "../types";
import { clampValue, readTerminalScrollState } from "../utils/terminal";

export function useTerminalScroll(terminalRef: RefObject<Terminal | null>) {
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  const scrollPointerIdRef = useRef<number | null>(null);
  const [scrollState, setScrollState] = useState<TerminalScrollState>({
    viewportY: 0,
    baseY: 0,
  });

  const updateTerminalScrollState = useCallback(
    (terminal = terminalRef.current) => {
      const next = readTerminalScrollState(terminal);
      setScrollState((current) =>
        current.viewportY === next.viewportY && current.baseY === next.baseY
          ? current
          : next,
      );
    },
    [terminalRef],
  );

  const resetScrollState = useCallback(() => {
    setScrollState({ viewportY: 0, baseY: 0 });
  }, []);

  const scrollTerminalToClientY = useCallback(
    (clientY: number) => {
      const terminal = terminalRef.current;
      const track = scrollTrackRef.current;
      if (!terminal || !track || scrollState.baseY === 0) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const ratio = clampValue(
        ((clientY - rect.top) / rect.height) * 1000,
        0,
        1000,
      );
      terminal.scrollToLine(Math.round((ratio / 1000) * scrollState.baseY));
      updateTerminalScrollState(terminal);
    },
    [scrollState.baseY, terminalRef, updateTerminalScrollState],
  );

  const scrollTerminalToLine = useCallback(
    (line: number) => {
      const terminal = terminalRef.current;
      if (!terminal || scrollState.baseY === 0) {
        return;
      }

      terminal.scrollToLine(clampValue(line, 0, scrollState.baseY));
      updateTerminalScrollState(terminal);
    },
    [scrollState.baseY, terminalRef, updateTerminalScrollState],
  );

  const handleScrollPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollState.baseY === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      scrollPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollTerminalToClientY(event.clientY);
    },
    [scrollState.baseY, scrollTerminalToClientY],
  );

  const handleScrollPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollPointerIdRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      scrollTerminalToClientY(event.clientY);
    },
    [scrollTerminalToClientY],
  );

  const handleScrollPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollPointerIdRef.current !== event.pointerId) {
        return;
      }

      scrollPointerIdRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      scrollTerminalToClientY(event.clientY);
    },
    [scrollTerminalToClientY],
  );

  const handleScrollKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const terminal = terminalRef.current;
      if (!terminal || scrollState.baseY === 0) {
        return;
      }

      const pageStep = Math.max(1, terminal.rows - 1);
      let nextLine: number | null = null;

      switch (event.key) {
        case "ArrowUp":
          nextLine = scrollState.viewportY - 1;
          break;
        case "ArrowDown":
          nextLine = scrollState.viewportY + 1;
          break;
        case "PageUp":
          nextLine = scrollState.viewportY - pageStep;
          break;
        case "PageDown":
          nextLine = scrollState.viewportY + pageStep;
          break;
        case "Home":
          nextLine = 0;
          break;
        case "End":
          nextLine = scrollState.baseY;
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      scrollTerminalToLine(nextLine);
    },
    [
      scrollState.baseY,
      scrollState.viewportY,
      scrollTerminalToLine,
      terminalRef,
    ],
  );

  return {
    handleScrollKeyDown,
    handleScrollPointerDown,
    handleScrollPointerMove,
    handleScrollPointerUp,
    resetScrollState,
    scrollState,
    scrollTrackRef,
    updateTerminalScrollState,
  };
}
