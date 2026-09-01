import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";

const liveTerminalWriteChunkSize = 32 * 1024;
const snapshotTerminalWriteChunkSize = 256 * 1024;

type TerminalWriteOperation = { type: "write"; data: string };

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function chunkTerminalData(data: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < data.length) {
    let end = Math.min(data.length, start + chunkSize);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (end <= start) {
      end = Math.min(data.length, start + chunkSize);
    }

    chunks.push(data.slice(start, end));
    start = end;
  }

  return chunks;
}

function writeOperationsFor(data: string): TerminalWriteOperation[] {
  return chunkTerminalData(data, liveTerminalWriteChunkSize).map((chunk) => ({
    type: "write",
    data: chunk,
  }));
}

export function useTerminalWriter(
  terminalRef: RefObject<Terminal | null>,
  updateTerminalScrollState: (terminal?: Terminal | null) => void,
) {
  const [isRestoringOutput, setIsRestoringOutputState] = useState(false);
  const isRestoringOutputRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);
  const writeFrameRef = useRef<number | null>(null);
  const writeGenerationRef = useRef(0);
  const writeInProgressRef = useRef(false);
  const writeQueueRef = useRef<TerminalWriteOperation[]>([]);
  const flushTerminalWritesRef = useRef<(generation: number) => void>(
    () => undefined,
  );

  const setIsRestoringOutput = useCallback((value: boolean) => {
    if (isRestoringOutputRef.current === value) {
      return;
    }
    isRestoringOutputRef.current = value;
    setIsRestoringOutputState(value);
  }, []);

  const cancelScheduledFlush = useCallback(() => {
    if (writeFrameRef.current !== null) {
      window.cancelAnimationFrame(writeFrameRef.current);
      writeFrameRef.current = null;
    }
  }, []);

  const cancelScheduledRestore = useCallback(() => {
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
  }, []);

  const cancelTerminalWrites = useCallback(() => {
    writeGenerationRef.current += 1;
    writeQueueRef.current = [];
    writeInProgressRef.current = false;
    setIsRestoringOutput(false);
    cancelScheduledFlush();
    cancelScheduledRestore();
  }, [cancelScheduledFlush, cancelScheduledRestore, setIsRestoringOutput]);

  const scheduleTerminalWriteFlush = useCallback(() => {
    if (writeFrameRef.current !== null || writeInProgressRef.current) {
      return;
    }

    const generation = writeGenerationRef.current;
    writeFrameRef.current = window.requestAnimationFrame(() => {
      writeFrameRef.current = null;
      flushTerminalWritesRef.current(generation);
    });
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

      const operation = writeQueueRef.current.shift();
      if (!operation) {
        return;
      }

      writeInProgressRef.current = true;
      terminal.write(operation.data, () => {
        if (generation !== writeGenerationRef.current) {
          return;
        }

        writeInProgressRef.current = false;
        updateTerminalScrollState(terminal);
        if (!writeQueueRef.current.length) {
          return;
        }

        scheduleTerminalWriteFlush();
      });
    },
    [scheduleTerminalWriteFlush, terminalRef, updateTerminalScrollState],
  );

  useEffect(() => {
    flushTerminalWritesRef.current = flushTerminalWrites;
  }, [flushTerminalWrites]);

  const queueTerminalWrite = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      writeQueueRef.current.push(...writeOperationsFor(data));
      scheduleTerminalWriteFlush();
    },
    [scheduleTerminalWriteFlush],
  );

  const restoreTerminalSnapshot = useCallback(
    (buffer: string) => {
      const terminal = terminalRef.current;
      writeGenerationRef.current += 1;
      const generation = writeGenerationRef.current;
      writeQueueRef.current = [];
      cancelScheduledFlush();
      cancelScheduledRestore();

      if (!terminal) {
        writeInProgressRef.current = false;
        setIsRestoringOutput(false);
        return;
      }

      writeInProgressRef.current = true;
      setIsRestoringOutput(Boolean(buffer));
      terminal.reset();

      if (!buffer) {
        writeInProgressRef.current = false;
        terminal.scrollToBottom();
        updateTerminalScrollState(terminal);
        setIsRestoringOutput(false);
        scheduleTerminalWriteFlush();
        return;
      }

      const chunks = chunkTerminalData(buffer, snapshotTerminalWriteChunkSize);
      let chunkIndex = 0;

      const finishRestore = () => {
        if (
          generation !== writeGenerationRef.current ||
          terminal !== terminalRef.current
        ) {
          return;
        }

        writeInProgressRef.current = false;
        terminal.scrollToBottom();
        updateTerminalScrollState(terminal);
        setIsRestoringOutput(false);
        scheduleTerminalWriteFlush();
      };

      const writeNextChunk = () => {
        if (
          generation !== writeGenerationRef.current ||
          terminal !== terminalRef.current
        ) {
          return;
        }

        const chunk = chunks[chunkIndex];
        chunkIndex += 1;
        if (!chunk) {
          finishRestore();
          return;
        }

        terminal.write(chunk, writeNextChunk);
      };

      // Let React apply the restoring class before xterm mutates its viewport.
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        writeNextChunk();
      });
    },
    [
      cancelScheduledFlush,
      cancelScheduledRestore,
      scheduleTerminalWriteFlush,
      setIsRestoringOutput,
      terminalRef,
      updateTerminalScrollState,
    ],
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
    isRestoringOutput,
    isRestoringOutputRef,
    queueTerminalWrite,
    resetTerminalOutput,
    restoreTerminalSnapshot,
  };
}
