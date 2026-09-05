import type {
  TerminalBufferType,
  TerminalSnapshotMode,
  TerminalTarget,
} from "./types";

export type TerminalStreamSnapshotEvent = {
  type: "snapshot";
  requestId: string;
  sessionId: string;
  terminalId: string;
  runtimeId: number | null;
  format: "xterm-serialized-vt";
  mode: TerminalSnapshotMode;
  data: string;
  seq: number;
  minSeq: number | null;
  complete: boolean;
  cols: number;
  rows: number;
  screenRevision: number;
  bufferType: TerminalBufferType;
};

export type TerminalStreamOutputEvent = {
  type: "output";
  sessionId: string;
  terminalId: string;
  runtimeId: number;
  data: string;
  at: string;
  seq: number;
};

export type TerminalStreamProgressEvent = {
  type: "progress";
  sessionId: string;
  terminalId: string;
  runtimeId: number;
  seq: number;
  screenRevision: number;
  bufferType: TerminalBufferType;
  cols: number;
  rows: number;
};

export type TerminalStreamEvent =
  | TerminalStreamSnapshotEvent
  | TerminalStreamOutputEvent
  | TerminalStreamProgressEvent;

export type TerminalStreamSink = (event: TerminalStreamEvent) => void;

export type TerminalStream = {
  publish: (event: TerminalStreamEvent) => void;
  subscribe: (target: TerminalTarget, sink: TerminalStreamSink) => () => void;
};

function targetKey(target: TerminalTarget): string {
  return `${target.sessionId}\u0000${target.terminalId}`;
}

export function createTerminalStream(): TerminalStream {
  const subscribers = new Map<string, Set<TerminalStreamSink>>();

  return {
    publish(event) {
      const key = targetKey(event);
      const sinks = subscribers.get(key);
      if (!sinks) {
        return;
      }

      Array.from(sinks).forEach((sink) => sink(event));
    },

    subscribe(target, sink) {
      const key = targetKey(target);
      let sinks = subscribers.get(key);
      if (!sinks) {
        sinks = new Set<TerminalStreamSink>();
        subscribers.set(key, sinks);
      }
      sinks.add(sink);

      return () => {
        sinks?.delete(sink);
        if (sinks?.size === 0) {
          subscribers.delete(key);
        }
      };
    },
  };
}
