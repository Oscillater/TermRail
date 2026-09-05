import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { focusTerminalPreventScroll } from "../utils/terminal";

type TerminalSlotName = "a" | "b";

type Disposable = {
  dispose: () => void;
};

type TerminalSlot = {
  container: HTMLDivElement;
  disposables: Disposable[];
  fitAddon: FitAddon;
  handleViewportScroll: () => void;
  name: TerminalSlotName;
  terminal: Terminal;
  viewport: Element | null;
};

type UseXtermInstanceOptions = {
  onAfterFit?: (terminal: Terminal) => void;
  onBeforeFit?: (terminal: Terminal) => void;
  onCopyShortcut: (terminal: Terminal) => void;
  onData: (data: string) => void;
  onDispose: () => void;
  onPasteShortcut: (terminal: Terminal) => void;
  onReady: (terminal: Terminal) => void;
  onResize: (terminal: Terminal, cols: number, rows: number) => void;
  onScroll: (terminal: Terminal) => void;
};

function canFitTerminal(container: HTMLElement | null): boolean {
  if (!container) {
    return false;
  }

  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function willFitResizeTerminal(
  fitAddon: FitAddon,
  terminal: Terminal,
): boolean {
  const dimensions = fitAddon.proposeDimensions();
  return Boolean(
    dimensions &&
    (dimensions.cols !== terminal.cols || dimensions.rows !== terminal.rows),
  );
}

function otherSlotName(slotName: TerminalSlotName): TerminalSlotName {
  return slotName === "a" ? "b" : "a";
}

function createTerminal(): Terminal {
  return new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    fontFamily:
      '"CaskaydiaMono Nerd Font Mono", "CaskaydiaMono Nerd Font", "CaskaydiaCove Nerd Font Mono", "CaskaydiaCove Nerd Font", "0xProto Nerd Font Mono", "0xProto Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, SFMono-Regular, "Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 100000,
    theme: {
      background: "#111315",
      black: "#111315",
      blue: "#5ba8ff",
      brightBlack: "#666f7a",
      brightBlue: "#8ec5ff",
      brightCyan: "#8adfd9",
      brightGreen: "#91d18b",
      brightMagenta: "#e3a5f3",
      brightRed: "#ff8b8b",
      brightWhite: "#f8fafc",
      brightYellow: "#ffd27a",
      cyan: "#61c5bf",
      foreground: "#d8dee9",
      green: "#74b86f",
      magenta: "#c67edb",
      red: "#ef7373",
      white: "#d8dee9",
      yellow: "#e8b457",
    },
  });
}

export function useXtermInstance(
  terminalRef: RefObject<Terminal | null>,
  stagingTerminalRef: RefObject<Terminal | null>,
  callbacks: UseXtermInstanceOptions,
) {
  const slotAContainerRef = useRef<HTMLDivElement | null>(null);
  const slotBContainerRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<Record<TerminalSlotName, TerminalSlot | null>>({
    a: null,
    b: null,
  });
  const activeSlotRef = useRef<TerminalSlotName>("a");
  const pendingFocusTransferRef = useRef<TerminalSlotName | null>(null);
  const [activeSlotName, setActiveSlotName] = useState<TerminalSlotName>("a");
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const syncTerminalRefs = useCallback(
    (activeSlotName: TerminalSlotName) => {
      const activeSlot = slotsRef.current[activeSlotName];
      const stagingSlot = slotsRef.current[otherSlotName(activeSlotName)];
      terminalRef.current = activeSlot?.terminal ?? null;
      stagingTerminalRef.current = stagingSlot?.terminal ?? null;
      if (stagingSlot) {
        stagingSlot.terminal.options.disableStdin = true;
      }
    },
    [stagingTerminalRef, terminalRef],
  );

  const fitSlot = useCallback(
    (slot: TerminalSlot, options: { notify: boolean; stabilize: boolean }) => {
      if (!canFitTerminal(slot.container)) {
        return;
      }

      const shouldStabilize =
        options.stabilize &&
        slot.name === activeSlotRef.current &&
        willFitResizeTerminal(slot.fitAddon, slot.terminal);
      if (shouldStabilize) {
        callbacksRef.current.onBeforeFit?.(slot.terminal);
      }
      slot.fitAddon.fit();
      if (shouldStabilize) {
        callbacksRef.current.onAfterFit?.(slot.terminal);
      }
      if (options.notify && slot.name === activeSlotRef.current) {
        callbacksRef.current.onReady(slot.terminal);
        slot.terminal.refresh(0, Math.max(0, slot.terminal.rows - 1));
      }
    },
    [],
  );

  const fitAllSlots = useCallback(
    (options: { notify: boolean; stabilize: boolean }) => {
      const slots = slotsRef.current;
      const activeSlot = slots[activeSlotRef.current];
      const stagingSlot = slots[otherSlotName(activeSlotRef.current)];
      if (activeSlot) {
        fitSlot(activeSlot, options);
      }
      if (stagingSlot) {
        fitSlot(stagingSlot, { notify: false, stabilize: false });
      }
    },
    [fitSlot],
  );

  const fitTerminal = useCallback(() => {
    fitAllSlots({ notify: true, stabilize: true });
  }, [fitAllSlots]);

  const promoteStagingTerminal = useCallback(() => {
    const nextActiveSlotName = otherSlotName(activeSlotRef.current);
    const nextActiveSlot = slotsRef.current[nextActiveSlotName];
    const nextStagingSlot = slotsRef.current[activeSlotRef.current];
    if (!nextActiveSlot || !nextStagingSlot) {
      return terminalRef.current;
    }

    const shouldTransferFocus =
      document.activeElement === nextStagingSlot.terminal.textarea;

    nextActiveSlot.terminal.options.disableStdin = false;
    nextStagingSlot.terminal.options.disableStdin = true;
    activeSlotRef.current = nextActiveSlotName;
    syncTerminalRefs(nextActiveSlotName);
    pendingFocusTransferRef.current = shouldTransferFocus
      ? nextActiveSlotName
      : null;
    setActiveSlotName(nextActiveSlotName);
    fitSlot(nextActiveSlot, { notify: true, stabilize: false });
    return nextActiveSlot.terminal;
  }, [fitSlot, syncTerminalRefs, terminalRef]);

  useLayoutEffect(() => {
    if (pendingFocusTransferRef.current !== activeSlotName) {
      return;
    }

    const activeSlot = slotsRef.current[activeSlotName];
    if (activeSlot && focusTerminalPreventScroll(activeSlot.terminal)) {
      pendingFocusTransferRef.current = null;
    }
  }, [activeSlotName]);

  useEffect(() => {
    const createSlot = (
      name: TerminalSlotName,
      container: HTMLDivElement,
    ): TerminalSlot => {
      const terminal = createTerminal();
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      try {
        terminal.loadAddon(new CanvasAddon());
      } catch {
        // Fall back to the default DOM renderer if canvas is unavailable.
      }
      terminal.options.disableStdin = name !== activeSlotRef.current;

      terminal.attachCustomKeyEventHandler((event) => {
        if (name !== activeSlotRef.current) {
          return true;
        }
        if (event.type !== "keydown" || !event.ctrlKey || event.altKey) {
          return true;
        }

        const key = event.key.toLowerCase();
        const isCopyShortcut = key === "c" && terminal.hasSelection();
        const isPasteShortcut = key === "v";

        if (!isCopyShortcut && !isPasteShortcut) {
          return true;
        }

        event.preventDefault();
        event.stopPropagation();
        if (isCopyShortcut) {
          callbacksRef.current.onCopyShortcut(terminal);
        } else {
          callbacksRef.current.onPasteShortcut(terminal);
        }
        return false;
      });

      const disposables: Disposable[] = [
        terminal.onData((data) => {
          if (name === activeSlotRef.current) {
            callbacksRef.current.onData(data);
          }
        }),
        terminal.onResize(({ cols, rows }) => {
          if (name === activeSlotRef.current) {
            callbacksRef.current.onResize(terminal, cols, rows);
          }
        }),
        terminal.onScroll(() => {
          if (name === activeSlotRef.current) {
            callbacksRef.current.onScroll(terminal);
          }
        }),
      ];
      const viewport = container.querySelector(".xterm-viewport");
      const handleViewportScroll = () => {
        if (name === activeSlotRef.current) {
          callbacksRef.current.onScroll(terminal);
        }
      };
      viewport?.addEventListener("scroll", handleViewportScroll, {
        passive: true,
      });

      return {
        container,
        disposables,
        fitAddon,
        handleViewportScroll,
        name,
        terminal,
        viewport,
      };
    };

    const containerA = slotAContainerRef.current;
    const containerB = slotBContainerRef.current;
    if (!containerA || !containerB) {
      return undefined;
    }

    activeSlotRef.current = "a";
    pendingFocusTransferRef.current = null;
    const slotA = createSlot("a", containerA);
    const slotB = createSlot("b", containerB);
    slotsRef.current = { a: slotA, b: slotB };
    syncTerminalRefs("a");
    setActiveSlotName("a");
    fitAllSlots({ notify: true, stabilize: false });

    let resizeFrame: number | null = null;
    const fit = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAllSlots({ notify: true, stabilize: true });
      });
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(containerA);
    resizeObserver.observe(containerB);
    fit();

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver.disconnect();
      callbacksRef.current.onDispose();
      Object.values(slotsRef.current).forEach((slot) => {
        if (!slot) {
          return;
        }
        slot.viewport?.removeEventListener("scroll", slot.handleViewportScroll);
        slot.disposables.forEach((disposable) => disposable.dispose());
        slot.terminal.dispose();
      });
      slotsRef.current = { a: null, b: null };
      pendingFocusTransferRef.current = null;
      terminalRef.current = null;
      stagingTerminalRef.current = null;
    };
  }, [fitAllSlots, stagingTerminalRef, syncTerminalRefs, terminalRef]);

  return {
    activeSlotName,
    promoteStagingTerminal,
    slotAContainerRef,
    slotBContainerRef,
    fitTerminal,
  };
}
