import type { TerminalTarget } from "./types";

export type TerminalStreamSnapshotEvent = {
  type: "snapshot";
  sessionId: string;
  terminalId: string;
  buffer: string;
};

export type TerminalStreamOutputEvent = {
  type: "output";
  sessionId: string;
  terminalId: string;
  data: string;
  at: string;
  seq: number;
};

export type TerminalStreamEvent =
  TerminalStreamSnapshotEvent | TerminalStreamOutputEvent;

export type TerminalStreamSink = (event: TerminalStreamEvent) => void;

export type TerminalStream = {
  clearSnapshot: (target: TerminalTarget) => void;
  publish: (event: TerminalStreamEvent) => void;
  subscribe: (target: TerminalTarget, sink: TerminalStreamSink) => () => void;
};

function targetKey(target: TerminalTarget): string {
  return `${target.sessionId}\u0000${target.terminalId}`;
}

export function createTerminalStream(): TerminalStream {
  const snapshots = new Map<string, TerminalStreamSnapshotEvent>();
  const subscribers = new Map<string, Set<TerminalStreamSink>>();

  return {
    clearSnapshot(target) {
      snapshots.delete(targetKey(target));
    },

    publish(event) {
      const key = targetKey(event);
      if (event.type === "snapshot") {
        snapshots.set(key, event);
      }

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

      const snapshot = snapshots.get(key);
      if (snapshot) {
        sink(snapshot);
      }

      return () => {
        sinks?.delete(sink);
        if (sinks?.size === 0) {
          subscribers.delete(key);
        }
      };
    },
  };
}
