import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import type {
  RuntimeStatus,
  StreamConnectionState,
  TerminalFocusRequest,
  TerminalInputRequest,
  TerminalSnapshotRequestOptions,
  TerminalSize,
} from "../types";
import type {
  TerminalStream,
  TerminalStreamOutputEvent,
  TerminalStreamProgressEvent,
} from "../terminalStream";
import {
  isSequenceAhead,
  shouldEnterTerminalCatchUp,
  type TerminalProgressPosition,
} from "../terminalCatchUp";
import { useTerminalClipboard } from "../hooks/useTerminalClipboard";
import { useTerminalScroll } from "../hooks/useTerminalScroll";
import {
  useTerminalWriter,
  type TerminalWriterBacklog,
} from "../hooks/useTerminalWriter";
import { useXtermInstance } from "../hooks/useXtermInstance";
import {
  clampTerminalSize,
  focusTerminalPreventScroll,
  readTerminalScrollState,
} from "../utils/terminal";

export type TerminalViewportHandle = {
  focus: () => void;
  fit: () => void;
};

type TerminalViewportProps = {
  connectionState: StreamConnectionState;
  focusRequest: TerminalFocusRequest | null;
  inputRequest: TerminalInputRequest | null;
  keyboardOwner: "terminal" | "form";
  onCreateTerminalClick: () => void;
  onError: (message: string | null) => void;
  onFocusFormRequest: () => void;
  onInput: (sessionId: string, terminalId: string, data: string) => boolean;
  onResize: (
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ) => boolean;
  onSize: (size: TerminalSize) => void;
  onSnapshotRequest: (
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    options?: TerminalSnapshotRequestOptions,
  ) => boolean;
  onVisibleOutputApplied: (sessionId: string, terminalId: string) => void;
  savingTerminal: boolean;
  sessionId: string | null;
  status: RuntimeStatus | undefined;
  terminalExists: boolean;
  terminalId: string | null;
  terminalStream: TerminalStream;
};

type TerminalPhase = "idle" | "loading" | "live" | "catching-up" | "installing";
type OverlayKind = "loading" | "catching-up" | null;
type SnapshotPurpose = "loading" | "catching-up";
type TerminalSequencePosition = {
  runtimeId: number | null;
  seq: number;
};

const loadingOverlayDelayMs = 150;
const catchUpBacklogAgeMs = 750;
const catchUpConfirmationMs = 250;
const snapshotRequestTimeoutMs = 10_000;
const snapshotRetryDelayMs = 250;
const maxResidualBytes = 256 * 1024;

function isTerminalNearBottom(terminal: Terminal): boolean {
  const scrollState = readTerminalScrollState(terminal);
  return scrollState.baseY - scrollState.viewportY <= 1;
}

function progressPosition(
  event: TerminalStreamProgressEvent,
): TerminalProgressPosition {
  return {
    runtimeId: event.runtimeId,
    seq: event.seq,
    screenRevision: event.screenRevision,
    bufferType: event.bufferType,
  };
}

export const TerminalViewport = forwardRef<
  TerminalViewportHandle,
  TerminalViewportProps
>(function TerminalViewport(
  {
    connectionState,
    focusRequest,
    inputRequest,
    keyboardOwner,
    onCreateTerminalClick,
    onError,
    onFocusFormRequest,
    onInput,
    onResize,
    onSize,
    onSnapshotRequest,
    onVisibleOutputApplied,
    savingTerminal,
    sessionId,
    status,
    terminalExists,
    terminalId,
    terminalStream,
  },
  ref,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const stagingTerminalRef = useRef<Terminal | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const connectionStateRef = useRef(connectionState);
  const keyboardOwnerRef = useRef(keyboardOwner);
  const statusRef = useRef(status);
  const lastResizeRef = useRef<TerminalSize | null>(null);
  const phaseRef = useRef<TerminalPhase>("idle");
  const latestAppliedRef = useRef<TerminalProgressPosition | null>(null);
  const latestReceivedRef = useRef<TerminalSequencePosition | null>(null);
  const latestProgressRef = useRef<TerminalProgressPosition | null>(null);
  const progressCheckpointsRef = useRef<TerminalProgressPosition[]>([]);
  const residualOutputRef = useRef<TerminalStreamOutputEvent[]>([]);
  const residualBytesRef = useRef(0);
  const residualDroppedRef = useRef(false);
  const residualCaptureEnabledRef = useRef(false);
  const snapshotPurposeRef = useRef<SnapshotPurpose | null>(null);
  const snapshotTargetSeqRef = useRef(0);
  const catchUpReleaseSeqRef = useRef(0);
  const catchUpReleaseRuntimeIdRef = useRef<number | null>(null);
  const writerBacklogRef = useRef<TerminalWriterBacklog>({
    oldestPendingAt: null,
    pendingBytes: 0,
  });
  const handledFocusRequestRef = useRef(0);
  const focusRequestRef = useRef<TerminalFocusRequest | null>(focusRequest);
  const loadingOverlayTimerRef = useRef<number | null>(null);
  const catchUpConfirmationTimerRef = useRef<number | null>(null);
  const snapshotTimeoutRef = useRef<number | null>(null);
  const snapshotRetryRef = useRef<number | null>(null);
  const resizeScrollTargetRef = useRef<{
    distanceFromBottom: number;
    wasAtBottom: boolean;
  } | null>(null);
  const requestSnapshotRef = useRef<
    (purpose: SnapshotPurpose, minSeq?: number) => boolean
  >(() => false);
  const requestCatchUpSnapshotRef = useRef<() => void>(() => undefined);
  const evaluateCatchUpRef = useRef<() => void>(() => undefined);
  const focusRequestedTerminalRef = useRef<() => void>(() => undefined);
  const promoteStagingTerminalRef = useRef<() => Terminal | null>(() => null);
  const [phase, setPhaseState] = useState<TerminalPhase>("idle");
  const [overlayKind, setOverlayKind] = useState<OverlayKind>(null);

  useLayoutEffect(() => {
    activeSessionIdRef.current = sessionId;
    activeTerminalIdRef.current = terminalId;
  }, [sessionId, terminalId]);

  const {
    handleScrollKeyDown,
    handleScrollPointerDown,
    handleScrollPointerMove,
    handleScrollPointerUp,
    resetScrollState,
    scrollState,
    scrollTrackRef,
    updateTerminalScrollState,
  } = useTerminalScroll(terminalRef);
  const { copyTerminalSelection, pasteTerminalClipboard } =
    useTerminalClipboard(onError);

  const setPhase = useCallback((next: TerminalPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearTimer = useCallback((timerRef: { current: number | null }) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearAllTimers = useCallback(() => {
    clearTimer(loadingOverlayTimerRef);
    clearTimer(catchUpConfirmationTimerRef);
    clearTimer(snapshotTimeoutRef);
    clearTimer(snapshotRetryRef);
  }, [clearTimer]);

  const clearResidualOutput = useCallback(() => {
    residualOutputRef.current = [];
    residualBytesRef.current = 0;
    residualDroppedRef.current = false;
  }, []);

  const markVisibleOutputApplied = useCallback(() => {
    const activeSessionId = activeSessionIdRef.current;
    const activeTerminalId = activeTerminalIdRef.current;
    if (activeSessionId && activeTerminalId) {
      onVisibleOutputApplied(activeSessionId, activeTerminalId);
    }
  }, [onVisibleOutputApplied]);

  const focusRequestedTerminal = useCallback(() => {
    const request = focusRequestRef.current;
    if (
      !request ||
      request.id <= handledFocusRequestRef.current ||
      request.sessionId !== activeSessionIdRef.current ||
      request.terminalId !== activeTerminalIdRef.current ||
      keyboardOwnerRef.current !== "terminal"
    ) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.disableStdin = false;
    if (focusTerminalPreventScroll(terminal)) {
      handledFocusRequestRef.current = request.id;
    }
  }, []);

  useEffect(() => {
    focusRequestedTerminalRef.current = focusRequestedTerminal;
  }, [focusRequestedTerminal]);

  const rearmCurrentFocusRequest = useCallback(() => {
    const request = focusRequestRef.current;
    if (
      !request ||
      request.sessionId !== activeSessionIdRef.current ||
      request.terminalId !== activeTerminalIdRef.current ||
      handledFocusRequestRef.current < request.id
    ) {
      return;
    }
    handledFocusRequestRef.current = request.id - 1;
  }, []);

  const reconcileAppliedProgress = useCallback(() => {
    const applied = latestAppliedRef.current;
    if (!applied) {
      return;
    }

    const remaining: TerminalProgressPosition[] = [];
    let nextApplied = applied;
    progressCheckpointsRef.current.forEach((checkpoint) => {
      if (
        checkpoint.runtimeId === applied.runtimeId &&
        checkpoint.seq <= applied.seq
      ) {
        nextApplied = {
          ...nextApplied,
          screenRevision: Math.max(
            nextApplied.screenRevision,
            checkpoint.screenRevision,
          ),
          bufferType: checkpoint.bufferType,
        };
      } else {
        remaining.push(checkpoint);
      }
    });
    progressCheckpointsRef.current = remaining.slice(-64);
    latestAppliedRef.current = nextApplied;
  }, []);

  const scheduleLoadingOverlay = useCallback(() => {
    clearTimer(loadingOverlayTimerRef);
    setOverlayKind(null);
    loadingOverlayTimerRef.current = window.setTimeout(() => {
      loadingOverlayTimerRef.current = null;
      if (phaseRef.current === "loading") {
        setOverlayKind("loading");
      }
    }, loadingOverlayDelayMs);
  }, [clearTimer]);

  const beginLoading = useCallback(() => {
    rearmCurrentFocusRequest();
    clearTimer(catchUpConfirmationTimerRef);
    clearTimer(snapshotTimeoutRef);
    clearTimer(snapshotRetryRef);
    snapshotPurposeRef.current = null;
    catchUpReleaseSeqRef.current = 0;
    catchUpReleaseRuntimeIdRef.current = null;
    residualCaptureEnabledRef.current = false;
    clearResidualOutput();
    setPhase("loading");
    scheduleLoadingOverlay();
  }, [
    clearResidualOutput,
    clearTimer,
    rearmCurrentFocusRequest,
    scheduleLoadingOverlay,
    setPhase,
  ]);

  const publishTerminalSize = useCallback(
    (cols: number, rows: number) => {
      const size = clampTerminalSize(cols, rows);
      onSize(size);
      return size;
    },
    [onSize],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const activeSessionId = activeSessionIdRef.current;
      const activeTerminalId = activeTerminalIdRef.current;
      const size = clampTerminalSize(cols, rows);
      if (
        !activeSessionId ||
        !activeTerminalId ||
        connectionStateRef.current !== "connected" ||
        (lastResizeRef.current?.cols === size.cols &&
          lastResizeRef.current.rows === size.rows)
      ) {
        return;
      }
      lastResizeRef.current = size;
      onResize(activeSessionId, activeTerminalId, size.cols, size.rows);
    },
    [onResize],
  );

  const scheduleSnapshotRetry = useCallback(
    (purpose: SnapshotPurpose) => {
      clearTimer(snapshotRetryRef);
      snapshotRetryRef.current = window.setTimeout(() => {
        snapshotRetryRef.current = null;
        if (purpose === "loading" && phaseRef.current === "loading") {
          requestSnapshotRef.current("loading");
          return;
        }
        if (purpose === "catching-up" && phaseRef.current === "catching-up") {
          requestCatchUpSnapshotRef.current();
        }
      }, snapshotRetryDelayMs);
    },
    [clearTimer],
  );

  const scheduleSnapshotTimeout = useCallback(
    (purpose: SnapshotPurpose) => {
      clearTimer(snapshotTimeoutRef);
      snapshotTimeoutRef.current = window.setTimeout(() => {
        snapshotTimeoutRef.current = null;
        snapshotPurposeRef.current = null;
        onError("Terminal snapshot timed out; retrying");
        if (purpose === "loading") {
          setPhase("loading");
        } else {
          setPhase("catching-up");
          setOverlayKind("catching-up");
        }
        scheduleSnapshotRetry(purpose);
      }, snapshotRequestTimeoutMs);
    },
    [clearTimer, onError, scheduleSnapshotRetry, setPhase],
  );

  const requestSnapshot = useCallback(
    (purpose: SnapshotPurpose, minSeq?: number) => {
      const terminal = terminalRef.current;
      const activeSessionId = activeSessionIdRef.current;
      const activeTerminalId = activeTerminalIdRef.current;
      if (
        !terminal ||
        !activeSessionId ||
        !activeTerminalId ||
        connectionStateRef.current !== "connected"
      ) {
        return false;
      }

      const size = publishTerminalSize(terminal.cols, terminal.rows);
      sendResize(size.cols, size.rows);
      clearTimer(snapshotRetryRef);
      snapshotPurposeRef.current = purpose;
      snapshotTargetSeqRef.current = minSeq ?? 0;
      residualCaptureEnabledRef.current = true;
      clearResidualOutput();
      if (purpose === "catching-up") {
        setPhase("installing");
        setOverlayKind("catching-up");
      }

      const sent = onSnapshotRequest(
        activeSessionId,
        activeTerminalId,
        size.cols,
        size.rows,
        { mode: "full", minSeq },
      );
      if (!sent) {
        snapshotPurposeRef.current = null;
        if (purpose === "catching-up") {
          setPhase("catching-up");
        }
        scheduleSnapshotRetry(purpose);
        return false;
      }
      scheduleSnapshotTimeout(purpose);
      return true;
    },
    [
      clearResidualOutput,
      clearTimer,
      onSnapshotRequest,
      publishTerminalSize,
      scheduleSnapshotRetry,
      scheduleSnapshotTimeout,
      sendResize,
      setPhase,
    ],
  );

  useEffect(() => {
    requestSnapshotRef.current = requestSnapshot;
  }, [requestSnapshot]);

  const {
    cancelTerminalWrites,
    resetTerminalOutput,
    restoreTerminalSnapshot,
    writeLive,
  } = useTerminalWriter(
    terminalRef,
    stagingTerminalRef,
    () => promoteStagingTerminalRef.current(),
    {
      onBacklogChange: (backlog) => {
        writerBacklogRef.current = backlog;
        evaluateCatchUpRef.current();
      },
      onSnapshotApplied: (position) => {
        clearTimer(snapshotTimeoutRef);
        snapshotPurposeRef.current = null;
        latestAppliedRef.current = position;
        progressCheckpointsRef.current = progressCheckpointsRef.current.filter(
          (checkpoint) =>
            checkpoint.runtimeId === position.runtimeId &&
            checkpoint.seq > position.seq,
        );
        updateTerminalScrollState(terminalRef.current);

        const latestReceived = latestReceivedRef.current;
        if (!isSequenceAhead(latestReceived, position)) {
          residualCaptureEnabledRef.current = false;
          clearResidualOutput();
          catchUpReleaseSeqRef.current = 0;
          catchUpReleaseRuntimeIdRef.current = null;
          setPhase("live");
          setOverlayKind(null);
          onError(null);
          markVisibleOutputApplied();
          return;
        }

        const residual = residualOutputRef.current.filter(
          (event) =>
            event.runtimeId === position.runtimeId && event.seq > position.seq,
        );
        let expectedSeq = position.seq + 1;
        const residualIsContiguous = residual.every((event) => {
          if (event.seq !== expectedSeq) {
            return false;
          }
          expectedSeq += 1;
          return true;
        });
        if (
          residualDroppedRef.current ||
          latestReceived?.runtimeId !== position.runtimeId ||
          !residualIsContiguous ||
          expectedSeq - 1 !== latestReceived.seq
        ) {
          setPhase("catching-up");
          setOverlayKind("catching-up");
          requestCatchUpSnapshotRef.current();
          return;
        }

        residualCaptureEnabledRef.current = false;
        residualOutputRef.current = [];
        residualBytesRef.current = 0;
        residualDroppedRef.current = false;
        catchUpReleaseRuntimeIdRef.current = position.runtimeId;
        catchUpReleaseSeqRef.current = latestReceived.seq;
        setPhase("live");
        residual.forEach((event) => writeLive(event));
      },
      onWriteMetrics: (metrics) => {
        const previous = latestAppliedRef.current;
        latestAppliedRef.current = {
          runtimeId: metrics.runtimeId,
          seq: metrics.seq,
          screenRevision:
            previous?.runtimeId === metrics.runtimeId
              ? previous.screenRevision
              : 0,
          bufferType:
            previous?.runtimeId === metrics.runtimeId
              ? previous.bufferType
              : "normal",
        };
        reconcileAppliedProgress();
        if (
          catchUpReleaseSeqRef.current > 0 &&
          catchUpReleaseRuntimeIdRef.current === metrics.runtimeId &&
          metrics.seq >= catchUpReleaseSeqRef.current
        ) {
          catchUpReleaseSeqRef.current = 0;
          catchUpReleaseRuntimeIdRef.current = null;
          setOverlayKind(null);
          onError(null);
          markVisibleOutputApplied();
        } else if (
          metrics.kind === "live" &&
          catchUpReleaseSeqRef.current === 0
        ) {
          markVisibleOutputApplied();
        }
      },
      updateTerminalScrollState,
    },
  );

  const captureResidualOutput = useCallback(
    (event: TerminalStreamOutputEvent) => {
      if (
        !residualCaptureEnabledRef.current ||
        event.seq <= snapshotTargetSeqRef.current ||
        residualDroppedRef.current
      ) {
        return;
      }
      const nextBytes = residualBytesRef.current + event.data.length;
      if (nextBytes > maxResidualBytes) {
        clearResidualOutput();
        residualDroppedRef.current = true;
        return;
      }
      residualOutputRef.current.push(event);
      residualBytesRef.current = nextBytes;
    },
    [clearResidualOutput],
  );

  const requestCatchUpSnapshot = useCallback(() => {
    if (phaseRef.current !== "catching-up" || snapshotPurposeRef.current) {
      return;
    }
    const latestReceived = latestReceivedRef.current;
    if (!latestReceived) {
      return;
    }
    requestSnapshotRef.current("catching-up", latestReceived.seq);
  }, []);

  useEffect(() => {
    requestCatchUpSnapshotRef.current = requestCatchUpSnapshot;
  }, [requestCatchUpSnapshot]);

  const beginCatchUp = useCallback(() => {
    if (phaseRef.current !== "live") {
      return;
    }
    clearTimer(catchUpConfirmationTimerRef);
    cancelTerminalWrites();
    catchUpReleaseSeqRef.current = 0;
    catchUpReleaseRuntimeIdRef.current = null;
    setPhase("catching-up");
    setOverlayKind("catching-up");
    requestCatchUpSnapshotRef.current();
  }, [cancelTerminalWrites, clearTimer, setPhase]);

  const shouldCatchUpNow = useCallback(
    (minPendingMs: number) => {
      const terminal = terminalRef.current;
      const oldestPendingAt = writerBacklogRef.current.oldestPendingAt;
      if (
        !terminal ||
        phaseRef.current !== "live" ||
        catchUpReleaseSeqRef.current > 0
      ) {
        return false;
      }
      reconcileAppliedProgress();
      return shouldEnterTerminalCatchUp({
        applied: latestAppliedRef.current,
        atBottom: isTerminalNearBottom(terminal),
        minPendingMs,
        oldestPendingMs:
          oldestPendingAt === null
            ? null
            : Math.max(0, performance.now() - oldestPendingAt),
        received: latestProgressRef.current,
        rows: terminal.rows,
      });
    },
    [reconcileAppliedProgress],
  );

  const evaluateCatchUp = useCallback(() => {
    if (!shouldCatchUpNow(0)) {
      clearTimer(catchUpConfirmationTimerRef);
      return;
    }
    if (catchUpConfirmationTimerRef.current !== null) {
      return;
    }
    const oldestPendingAt = writerBacklogRef.current.oldestPendingAt;
    const oldestPendingMs =
      oldestPendingAt === null
        ? 0
        : Math.max(0, performance.now() - oldestPendingAt);
    if (oldestPendingMs < catchUpBacklogAgeMs) {
      catchUpConfirmationTimerRef.current = window.setTimeout(() => {
        catchUpConfirmationTimerRef.current = null;
        evaluateCatchUpRef.current();
      }, catchUpBacklogAgeMs - oldestPendingMs);
      return;
    }
    catchUpConfirmationTimerRef.current = window.setTimeout(() => {
      catchUpConfirmationTimerRef.current = null;
      if (shouldCatchUpNow(catchUpBacklogAgeMs)) {
        beginCatchUp();
      }
    }, catchUpConfirmationMs);
  }, [beginCatchUp, clearTimer, shouldCatchUpNow]);

  useEffect(() => {
    evaluateCatchUpRef.current = evaluateCatchUp;
  }, [evaluateCatchUp]);

  const sendTerminalInput = useCallback(
    (data: string, reportErrors: boolean) => {
      const activeSessionId = activeSessionIdRef.current;
      const activeTerminalId = activeTerminalIdRef.current;
      if (!data) {
        return true;
      }
      if (!activeSessionId || !activeTerminalId) {
        if (reportErrors) {
          onError("Select a terminal before sending input");
        }
        return false;
      }
      if (statusRef.current?.state !== "running") {
        if (reportErrors) {
          onError("Start the selected terminal before sending input");
        }
        return false;
      }
      if (connectionStateRef.current !== "connected") {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }
      if (!onInput(activeSessionId, activeTerminalId, data)) {
        if (reportErrors) {
          onError("WebSocket is not connected");
        }
        return false;
      }
      return true;
    },
    [onError, onInput],
  );

  const captureTerminalResizeScrollTarget = useCallback(
    (terminal: Terminal) => {
      const current = readTerminalScrollState(terminal);
      const distanceFromBottom = Math.max(0, current.baseY - current.viewportY);
      resizeScrollTargetRef.current = {
        distanceFromBottom,
        wasAtBottom: distanceFromBottom <= 1,
      };
    },
    [],
  );

  const restoreTerminalResizeScrollTarget = useCallback(
    (terminal: Terminal) => {
      const target = resizeScrollTargetRef.current;
      resizeScrollTargetRef.current = null;
      if (!target) {
        return;
      }
      if (target.wasAtBottom) {
        terminal.scrollToBottom();
      } else {
        const current = readTerminalScrollState(terminal);
        terminal.scrollToLine(
          Math.max(0, current.baseY - target.distanceFromBottom),
        );
      }
      updateTerminalScrollState(terminal);
    },
    [updateTerminalScrollState],
  );

  const {
    activeSlotName,
    fitTerminal,
    promoteStagingTerminal,
    slotAContainerRef,
    slotBContainerRef,
  } = useXtermInstance(terminalRef, stagingTerminalRef, {
    onAfterFit: restoreTerminalResizeScrollTarget,
    onBeforeFit: captureTerminalResizeScrollTarget,
    onCopyShortcut: (terminal) => void copyTerminalSelection(terminal),
    onData: (data) => sendTerminalInput(data, false),
    onDispose: () => {
      clearAllTimers();
      cancelTerminalWrites();
      clearResidualOutput();
      resetScrollState();
      setPhase("idle");
      setOverlayKind(null);
    },
    onPasteShortcut: (terminal) => void pasteTerminalClipboard(terminal),
    onReady: (terminal) => {
      publishTerminalSize(terminal.cols, terminal.rows);
      sendResize(terminal.cols, terminal.rows);
      updateTerminalScrollState(terminal);
      focusRequestedTerminalRef.current();
    },
    onResize: (terminal, cols, rows) => {
      publishTerminalSize(cols, rows);
      sendResize(cols, rows);
      updateTerminalScrollState(terminal);
    },
    onScroll: (terminal) => {
      if (phaseRef.current === "live") {
        updateTerminalScrollState(terminal);
        evaluateCatchUp();
      }
    },
  });

  useEffect(() => {
    promoteStagingTerminalRef.current = promoteStagingTerminal;
  }, [promoteStagingTerminal]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const terminal = terminalRef.current;
        if (terminal) {
          focusTerminalPreventScroll(terminal);
        }
      },
      fit: () => {
        fitTerminal();
        if (keyboardOwnerRef.current === "form") {
          onFocusFormRequest();
        }
      },
    }),
    [fitTerminal, onFocusFormRequest],
  );

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
    if (
      connectionState === "connected" &&
      activeSessionIdRef.current &&
      activeTerminalIdRef.current &&
      phaseRef.current === "loading" &&
      !snapshotPurposeRef.current
    ) {
      requestSnapshotRef.current("loading");
    }
  }, [connectionState]);

  useEffect(() => {
    lastResizeRef.current = null;
    latestAppliedRef.current = null;
    latestReceivedRef.current = null;
    latestProgressRef.current = null;
    progressCheckpointsRef.current = [];
    cancelTerminalWrites();
    clearAllTimers();
    clearResidualOutput();
    resetScrollState();

    const terminal = terminalRef.current;
    if (!terminal || !sessionId || !terminalId) {
      if (terminal) {
        resetTerminalOutput(terminal);
      }
      setPhase("idle");
      setOverlayKind(null);
      return;
    }

    onError(null);
    beginLoading();
    publishTerminalSize(terminal.cols, terminal.rows);
    requestSnapshotRef.current("loading");
  }, [
    beginLoading,
    cancelTerminalWrites,
    clearAllTimers,
    clearResidualOutput,
    onError,
    publishTerminalSize,
    resetScrollState,
    resetTerminalOutput,
    sessionId,
    setPhase,
    terminalId,
  ]);

  useEffect(() => {
    if (!sessionId || !terminalId) {
      return undefined;
    }

    return terminalStream.subscribe({ sessionId, terminalId }, (event) => {
      const terminal = terminalRef.current;
      if (
        !terminal ||
        event.sessionId !== activeSessionIdRef.current ||
        event.terminalId !== activeTerminalIdRef.current
      ) {
        return;
      }

      if (event.type === "progress") {
        const position = progressPosition(event);
        const current = latestProgressRef.current;
        if (
          current &&
          current.runtimeId === position.runtimeId &&
          current.seq > position.seq
        ) {
          return;
        }
        latestProgressRef.current = position;
        if (
          progressCheckpointsRef.current[0]?.runtimeId !== position.runtimeId
        ) {
          progressCheckpointsRef.current = [];
        }
        progressCheckpointsRef.current.push(position);
        reconcileAppliedProgress();
        evaluateCatchUp();
        return;
      }

      if (event.type === "snapshot") {
        clearTimer(snapshotTimeoutRef);
        const purpose = snapshotPurposeRef.current;
        snapshotPurposeRef.current = null;
        const currentSize = clampTerminalSize(terminal.cols, terminal.rows);
        if (
          event.format !== "xterm-serialized-vt" ||
          event.cols !== currentSize.cols ||
          event.rows !== currentSize.rows ||
          !event.complete
        ) {
          if (purpose === "loading") {
            setPhase("loading");
            scheduleSnapshotRetry("loading");
          } else {
            setPhase("catching-up");
            setOverlayKind("catching-up");
            scheduleSnapshotRetry("catching-up");
          }
          return;
        }

        const snapshotPosition: TerminalProgressPosition = {
          runtimeId: event.runtimeId,
          seq: event.seq,
          screenRevision: event.screenRevision,
          bufferType: event.bufferType,
        };
        if (isSequenceAhead(snapshotPosition, latestReceivedRef.current)) {
          latestReceivedRef.current = snapshotPosition;
        }
        if (
          !latestProgressRef.current ||
          isSequenceAhead(snapshotPosition, latestProgressRef.current)
        ) {
          latestProgressRef.current = snapshotPosition;
        }
        snapshotTargetSeqRef.current = event.seq;
        restoreTerminalSnapshot({
          data: event.data,
          runtimeId: event.runtimeId,
          seq: event.seq,
          screenRevision: event.screenRevision,
          bufferType: event.bufferType,
        });
        return;
      }

      const outputPosition = {
        runtimeId: event.runtimeId,
        seq: event.seq,
      };
      if (!isSequenceAhead(outputPosition, latestReceivedRef.current)) {
        return;
      }
      latestReceivedRef.current = outputPosition;

      if (phaseRef.current !== "live") {
        captureResidualOutput(event);
        return;
      }

      if (
        latestAppliedRef.current &&
        latestAppliedRef.current.runtimeId !== event.runtimeId
      ) {
        cancelTerminalWrites();
        beginLoading();
        requestSnapshotRef.current("loading", event.seq);
        return;
      }

      writeLive(event);
    });
  }, [
    beginLoading,
    cancelTerminalWrites,
    captureResidualOutput,
    clearTimer,
    evaluateCatchUp,
    reconcileAppliedProgress,
    restoreTerminalSnapshot,
    scheduleSnapshotRetry,
    sessionId,
    setPhase,
    terminalId,
    terminalStream,
    writeLive,
  ]);

  useEffect(() => {
    if (inputRequest) {
      sendTerminalInput(inputRequest.data, true);
    }
  }, [inputRequest, sendTerminalInput]);

  useLayoutEffect(() => {
    keyboardOwnerRef.current = keyboardOwner;
    const terminal = terminalRef.current;
    if (keyboardOwner === "terminal") {
      if (terminal) {
        terminal.options.disableStdin = false;
      }
      focusRequestedTerminalRef.current();
      return;
    }
    if (terminal) {
      terminal.options.disableStdin = true;
      terminal.blur();
    }
  }, [activeSlotName, keyboardOwner]);

  useLayoutEffect(() => {
    focusRequestRef.current = focusRequest;
    focusRequestedTerminalRef.current();
  }, [activeSlotName, focusRequest, phase]);

  const focusTerminalOrForm = () => {
    if (keyboardOwner === "form") {
      onFocusFormRequest();
      return;
    }
    const terminal = terminalRef.current;
    if (terminal && phaseRef.current === "live") {
      focusTerminalPreventScroll(terminal);
    }
  };

  const hasScrollback = scrollState.baseY > 0;
  const scrollProgress = hasScrollback
    ? scrollState.viewportY / scrollState.baseY
    : 0;
  const scrollThumbTop = `calc(${(scrollProgress * 100).toFixed(3)}% - ${(
    scrollProgress * 34
  ).toFixed(1)}px)`;
  const outputShielded =
    phase !== "idle" && (phase !== "live" || overlayKind !== null);
  const overlayText =
    overlayKind === "loading"
      ? "Loading terminal..."
      : overlayKind === "catching-up"
        ? "Catching up..."
        : null;
  const frameClassName = `terminal-frame${outputShielded ? " output-shielded" : ""}`;

  return (
    <div className={frameClassName} onClick={focusTerminalOrForm}>
      <div
        aria-hidden={activeSlotName !== "a"}
        className={`terminal-host ${activeSlotName === "a" ? "active" : "staging"}`}
        ref={slotAContainerRef}
      />
      <div
        aria-hidden={activeSlotName !== "b"}
        className={`terminal-host ${activeSlotName === "b" ? "active" : "staging"}`}
        ref={slotBContainerRef}
      />
      {terminalExists && overlayText ? (
        <div className="terminal-restore-overlay" aria-live="polite">
          {overlayText}
        </div>
      ) : null}
      {!terminalExists ? (
        <div className="terminal-empty-overlay">
          <h3>No terminal tabs</h3>
          <button
            className="primary-button"
            disabled={!sessionId || savingTerminal}
            onClick={(event) => {
              event.stopPropagation();
              onCreateTerminalClick();
            }}
            type="button"
          >
            New terminal
          </button>
        </div>
      ) : null}
      <div className="terminal-scroll-rail" aria-hidden={!hasScrollback}>
        <div
          aria-disabled={!hasScrollback}
          aria-label="Terminal scrollback"
          aria-orientation="vertical"
          aria-valuemax={scrollState.baseY}
          aria-valuemin={0}
          aria-valuenow={scrollState.viewportY}
          className={`terminal-scroll-control${hasScrollback ? "" : " disabled"}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleScrollKeyDown}
          onPointerCancel={handleScrollPointerUp}
          onPointerDown={handleScrollPointerDown}
          onPointerMove={handleScrollPointerMove}
          onPointerUp={handleScrollPointerUp}
          ref={scrollTrackRef}
          role="scrollbar"
          tabIndex={hasScrollback ? 0 : -1}
          title="Drag to scroll terminal history"
        >
          <span
            className="terminal-scroll-thumb"
            style={{ top: scrollThumbTop }}
          />
        </div>
      </div>
    </div>
  );
});
