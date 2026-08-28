import { type RefObject, useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";

export function useTerminalWriter(
  terminalRef: RefObject<Terminal | null>,
  updateTerminalScrollState: (terminal?: Terminal | null) => void,
) {
  const writeFrameRef = useRef<number | null>(null);
  const writeGenerationRef = useRef(0);
  const writeInProgressRef = useRef(false);
  const writeQueueRef = useRef("");

  const cancelTerminalWrites = useCallback(() => {
    writeGenerationRef.current += 1;
    writeQueueRef.current = "";
    writeInProgressRef.current = false;

    if (writeFrameRef.current !== null) {
      window.cancelAnimationFrame(writeFrameRef.current);
      writeFrameRef.current = null;
    }
  }, []);

  const flushTerminalWrites = useCallback(
    (generation: number) => {
      const terminal = terminalRef.current;
      if (
        !terminal ||
        writeInProgressRef.current ||
        generation !== writeGenerationRef.current
      ) {
        return;
      }

      const data = writeQueueRef.current;
      writeQueueRef.current = "";
      if (!data) {
        return;
      }

      writeInProgressRef.current = true;
      terminal.write(data, () => {
        writeInProgressRef.current = false;
        updateTerminalScrollState(terminal);
        if (
          generation !== writeGenerationRef.current ||
          !writeQueueRef.current
        ) {
          return;
        }

        writeFrameRef.current = window.requestAnimationFrame(() => {
          writeFrameRef.current = null;
          flushTerminalWrites(generation);
        });
      });
    },
    [terminalRef, updateTerminalScrollState],
  );

  const scheduleTerminalWriteFlush = useCallback(() => {
    if (writeFrameRef.current !== null || writeInProgressRef.current) {
      return;
    }

    const generation = writeGenerationRef.current;
    writeFrameRef.current = window.requestAnimationFrame(() => {
      writeFrameRef.current = null;
      flushTerminalWrites(generation);
    });
  }, [flushTerminalWrites]);

  const queueTerminalWrite = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      writeQueueRef.current += data;
      scheduleTerminalWriteFlush();
    },
    [scheduleTerminalWriteFlush],
  );

  const resetTerminalOutput = useCallback(
    (terminal: Terminal) => {
      cancelTerminalWrites();
      terminal.reset();
      updateTerminalScrollState(terminal);
    },
    [cancelTerminalWrites, updateTerminalScrollState],
  );

  useEffect(() => cancelTerminalWrites, [cancelTerminalWrites]);

  return {
    cancelTerminalWrites,
    queueTerminalWrite,
    resetTerminalOutput,
  };
}
