import { describe, expect, it } from "vitest";
import {
  isSequenceAhead,
  screenRevisionLag,
  shouldEnterTerminalCatchUp,
  type TerminalProgressPosition,
} from "./terminalCatchUp";

function position(
  overrides: Partial<TerminalProgressPosition> = {},
): TerminalProgressPosition {
  return {
    runtimeId: 1,
    seq: 10,
    screenRevision: 20,
    bufferType: "normal",
    ...overrides,
  };
}

describe("terminal catch-up decisions", () => {
  it("orders output only within the same runtime", () => {
    expect(isSequenceAhead(position({ seq: 11 }), position())).toBe(true);
    expect(isSequenceAhead(position({ seq: 9 }), position())).toBe(false);
    expect(
      isSequenceAhead(position({ runtimeId: 2, seq: 1 }), position()),
    ).toBe(true);
    expect(isSequenceAhead(position({ runtimeId: null }), position())).toBe(
      false,
    );
  });

  it("does not compare screen progress across runtimes", () => {
    expect(
      screenRevisionLag(
        position({ runtimeId: 2, screenRevision: 100 }),
        position({ runtimeId: 1, screenRevision: 1 }),
      ),
    ).toBe(0);
  });

  it("does not catch up while normal output is keeping pace", () => {
    expect(
      shouldEnterTerminalCatchUp({
        applied: position({ screenRevision: 20 }),
        atBottom: true,
        minPendingMs: 750,
        oldestPendingMs: 749,
        received: position({ screenRevision: 200 }),
        rows: 30,
      }),
    ).toBe(false);
  });

  it("does not catch up for less than one screen of lag", () => {
    expect(
      shouldEnterTerminalCatchUp({
        applied: position({ screenRevision: 20 }),
        atBottom: true,
        minPendingMs: 750,
        oldestPendingMs: 2_000,
        received: position({ screenRevision: 49 }),
        rows: 30,
      }),
    ).toBe(false);
  });

  it("does not catch up while the user is reading scrollback", () => {
    expect(
      shouldEnterTerminalCatchUp({
        applied: position({ screenRevision: 20 }),
        atBottom: false,
        minPendingMs: 750,
        oldestPendingMs: 2_000,
        received: position({ screenRevision: 50 }),
        rows: 30,
      }),
    ).toBe(false);
  });

  it("catches up after a full screen remains queued past the threshold", () => {
    expect(
      shouldEnterTerminalCatchUp({
        applied: position({ screenRevision: 20 }),
        atBottom: true,
        minPendingMs: 750,
        oldestPendingMs: 750,
        received: position({ screenRevision: 50 }),
        rows: 30,
      }),
    ).toBe(true);
  });
});
