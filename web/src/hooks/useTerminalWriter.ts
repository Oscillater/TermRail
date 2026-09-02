import { type RefObject, useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { TerminalBufferType } from "../types";

const liveTerminalWriteChunkSize = 128 * 1024;
const snapshotTerminalWriteChunkSize = 256 * 1024;

type TerminalWriteKind = "live" | "snapshot";

type TerminalWriteOperation = {
  data: string;
  enqueuedAt: number;
  kind: TerminalWriteKind;
  marksApplied: boolean;
  runtimeId: number | null;
  seq: number;
};

export type TerminalWriterBacklog = {
  oldestPendingAt: number | null;
  pendingBytes: number;
};

export type TerminalWriteMetrics = {
  kind: TerminalWriteKind;
  pendingBytes: number;
  runtimeId: number | null;
  seq: number;
  writeMs: number;
};

export type TerminalWriterSeq = {
  runtimeId: number | null;
  seq: number;
};

export type TerminalSnapshotWriterPosition = TerminalWriterSeq & {
  screenRevision: number;
  bufferType: TerminalBufferType;
};

type TerminalWriterEvent = TerminalWriterSeq & {
  data: string;
};

type UseTerminalWriterOptions = {
  onBacklogChange: (backlog: TerminalWriterBacklog) => void;
  onSnapshotApplied: (position: TerminalSnapshotWriterPosition) => void;
  onWriteMetrics: (metrics: TerminalWriteMetrics) => void;
  updateTerminalScrollState: (terminal?: Terminal | null) => void;
};

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

function writeOperationsFor({
  data,
  runtimeId,
  seq,
}: TerminalWriterEvent): TerminalWriteOperation[] {
  const chunks = chunkTerminalData(data, liveTerminalWriteChunkSize);
  const enqueuedAt = performance.now();
  return chunks.map((chunk, index) => ({
    data: chunk,
    enqueuedAt,
    kind: "live",
    marksApplied: index === chunks.length - 1,
    runtimeId,
    seq,
  }));
}

function takeNextWriteOperation(
  queue: TerminalWriteOperation[],
): TerminalWriteOperation | null {
  const first = queue.shift();
  if (!first || first.kind !== "live") {
    return first ?? null;
  }

  const data = [first.data];
  let length = first.data.length;
  let marksApplied = first.marksApplied;
  let seq = first.seq;

  while (queue.length) {
    const next = queue[0];
    if (
      !next ||
      next.kind !== first.kind ||
      next.runtimeId !== first.runtimeId ||
      length + next.data.length > liveTerminalWriteChunkSize
    ) {
      break;
    }
    queue.shift();
    data.push(next.data);
    length += next.data.length;
    if (next.marksApplied) {
      marksApplied = true;
      seq = next.seq;
    }
  }

  return {
    ...first,
    data: data.join(""),
    marksApplied,
    seq,
  };
}

export function useTerminalWriter(
  terminalRef: RefObject<Terminal | null>,
  stagingTerminalRef: RefObject<Terminal | null>,
  promoteStagingTerminal: () => Terminal | null,
  {
    onBacklogChange,
    onSnapshotApplied,
    onWriteMetrics,
    updateTerminalScrollState,
  }: UseTerminalWriterOptions,
) {
  const restoreFrameRef = useRef<number | null>(null);
  const writeFrameRef = useRef<number | null>(null);
  const writeGenerationRef = useRef(0);
  const writeInProgressRef = useRef(false);
  const inFlightOperationRef = useRef<TerminalWriteOperation | null>(null);
  const writeQueueRef = useRef<TerminalWriteOperation[]>([]);
  const pendingBytesRef = useRef(0);
  const onBacklogChangeRef = useRef(onBacklogChange);
  const onSnapshotAppliedRef = useRef(onSnapshotApplied);
  const onWriteMetricsRef = useRef(onWriteMetrics);
  const flushTerminalWritesRef = useRef<(generation: number) => void>(
    () => undefined,
  );

  useEffect(() => {
    onBacklogChangeRef.current = onBacklogChange;
  }, [onBacklogChange]);

  useEffect(() => {
    onSnapshotAppliedRef.current = onSnapshotApplied;
  }, [onSnapshotApplied]);

  useEffect(() => {
    onWriteMetricsRef.current = onWriteMetrics;
  }, [onWriteMetrics]);

  const readBacklog = useCallback(
    (): TerminalWriterBacklog => ({
      oldestPendingAt:
        inFlightOperationRef.current?.enqueuedAt ??
        writeQueueRef.current[0]?.enqueuedAt ??
        null,
      pendingBytes: pendingBytesRef.current,
    }),
    [],
  );

  const publishBacklog = useCallback(() => {
    onBacklogChangeRef.current(readBacklog());
  }, [readBacklog]);

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
    pendingBytesRef.current = 0;
    writeInProgressRef.current = false;
    inFlightOperationRef.current = null;
    cancelScheduledFlush();
    cancelScheduledRestore();
    publishBacklog();
  }, [cancelScheduledFlush, cancelScheduledRestore, publishBacklog]);

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

      const operation = takeNextWriteOperation(writeQueueRef.current);
      if (!operation) {
        return;
      }

      writeInProgressRef.current = true;
      inFlightOperationRef.current = operation;
      const startedAt = performance.now();
      terminal.write(operation.data, () => {
        if (generation !== writeGenerationRef.current) {
          return;
        }

        pendingBytesRef.current = Math.max(
          0,
          pendingBytesRef.current - operation.data.length,
        );
        writeInProgressRef.current = false;
        inFlightOperationRef.current = null;
        updateTerminalScrollState(terminal);
        if (operation.marksApplied) {
          onWriteMetricsRef.current({
            kind: operation.kind,
            pendingBytes: pendingBytesRef.current,
            runtimeId: operation.runtimeId,
            seq: operation.seq,
            writeMs: performance.now() - startedAt,
          });
        }
        publishBacklog();

        if (writeQueueRef.current.length) {
          scheduleTerminalWriteFlush();
        }
      });
    },
    [
      publishBacklog,
      scheduleTerminalWriteFlush,
      terminalRef,
      updateTerminalScrollState,
    ],
  );

  useEffect(() => {
    flushTerminalWritesRef.current = flushTerminalWrites;
  }, [flushTerminalWrites]);

  const enqueueTerminalData = useCallback(
    (operations: TerminalWriteOperation[]) => {
      pendingBytesRef.current += operations.reduce(
        (total, operation) => total + operation.data.length,
        0,
      );
      writeQueueRef.current.push(...operations);
      publishBacklog();
      scheduleTerminalWriteFlush();
    },
    [publishBacklog, scheduleTerminalWriteFlush],
  );

  const writeLive = useCallback(
    ({ data, runtimeId, seq }: TerminalWriterEvent) => {
      if (!data) {
        return;
      }

      const operations = writeOperationsFor({ data, runtimeId, seq });
      enqueueTerminalData(operations);
    },
    [enqueueTerminalData],
  );

  const restoreTerminalSnapshot = useCallback(
    ({
      bufferType,
      data,
      runtimeId,
      screenRevision,
      seq,
    }: TerminalWriterEvent & {
      bufferType: TerminalBufferType;
      screenRevision: number;
    }) => {
      const terminal = stagingTerminalRef.current;
      writeGenerationRef.current += 1;
      const generation = writeGenerationRef.current;
      writeQueueRef.current = [];
      pendingBytesRef.current = 0;
      inFlightOperationRef.current = null;
      cancelScheduledFlush();
      cancelScheduledRestore();
      publishBacklog();

      if (!terminal) {
        writeInProgressRef.current = false;
        return;
      }

      writeInProgressRef.current = true;

      const chunks = chunkTerminalData(data, snapshotTerminalWriteChunkSize);
      let chunkIndex = 0;

      const scheduleRestoreFrame = (callback: () => void) => {
        restoreFrameRef.current = window.requestAnimationFrame(() => {
          restoreFrameRef.current = null;
          callback();
        });
      };

      const finishRestore = () => {
        if (
          generation !== writeGenerationRef.current ||
          terminal !== stagingTerminalRef.current
        ) {
          return;
        }

        terminal.scrollToBottom();
        scheduleRestoreFrame(() => {
          if (
            generation !== writeGenerationRef.current ||
            terminal !== stagingTerminalRef.current
          ) {
            return;
          }

          const promotedTerminal = promoteStagingTerminal();
          if (!promotedTerminal) {
            writeInProgressRef.current = false;
            return;
          }
          promotedTerminal.scrollToBottom();
          promotedTerminal.refresh(0, Math.max(0, promotedTerminal.rows - 1));
          scheduleRestoreFrame(() => {
            if (
              generation !== writeGenerationRef.current ||
              promotedTerminal !== terminalRef.current
            ) {
              return;
            }

            writeInProgressRef.current = false;
            updateTerminalScrollState(promotedTerminal);
            onSnapshotAppliedRef.current({
              runtimeId,
              seq,
              screenRevision,
              bufferType,
            });
            scheduleTerminalWriteFlush();
          });
        });
      };

      const writeNextChunk = () => {
        if (
          generation !== writeGenerationRef.current ||
          terminal !== stagingTerminalRef.current
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

      scheduleRestoreFrame(() => {
        if (
          generation !== writeGenerationRef.current ||
          terminal !== stagingTerminalRef.current
        ) {
          return;
        }

        terminal.reset();
        if (!data) {
          finishRestore();
          return;
        }

        writeNextChunk();
      });
    },
    [
      cancelScheduledFlush,
      cancelScheduledRestore,
      publishBacklog,
      promoteStagingTerminal,
      scheduleTerminalWriteFlush,
      stagingTerminalRef,
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
    readBacklog,
    resetTerminalOutput,
    restoreTerminalSnapshot,
    writeLive,
  };
}
