import type { TerminalBufferType } from "./types";

export type TerminalProgressPosition = {
  runtimeId: number | null;
  seq: number;
  screenRevision: number;
  bufferType: TerminalBufferType;
};

export function isSequenceAhead(
  left: Pick<TerminalProgressPosition, "runtimeId" | "seq"> | null,
  right: Pick<TerminalProgressPosition, "runtimeId" | "seq"> | null,
): boolean {
  if (!left) {
    return false;
  }
  if (!right || left.runtimeId !== right.runtimeId) {
    return left.runtimeId !== null;
  }
  return left.seq > right.seq;
}

export function screenRevisionLag(
  received: TerminalProgressPosition | null,
  applied: TerminalProgressPosition | null,
): number {
  if (!received || !applied || received.runtimeId !== applied.runtimeId) {
    return 0;
  }
  return Math.max(0, received.screenRevision - applied.screenRevision);
}

export function shouldEnterTerminalCatchUp({
  applied,
  atBottom,
  minPendingMs,
  oldestPendingMs,
  received,
  rows,
}: {
  applied: TerminalProgressPosition | null;
  atBottom: boolean;
  minPendingMs: number;
  oldestPendingMs: number | null;
  received: TerminalProgressPosition | null;
  rows: number;
}): boolean {
  return (
    atBottom &&
    oldestPendingMs !== null &&
    oldestPendingMs >= minPendingMs &&
    screenRevisionLag(received, applied) >= Math.max(1, rows)
  );
}
