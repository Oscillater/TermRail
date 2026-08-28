import { type RefObject, useCallback, useEffect, useRef } from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type UseXtermInstanceOptions = {
  onCopyShortcut: (terminal: Terminal) => void;
  onData: (data: string) => void;
  onDispose: () => void;
  onPasteShortcut: (terminal: Terminal) => void;
  onReady: (terminal: Terminal) => void;
  onResize: (terminal: Terminal, cols: number, rows: number) => void;
  onScroll: (terminal: Terminal) => void;
};

export function useXtermInstance(
  terminalRef: RefObject<Terminal | null>,
  {
    onCopyShortcut,
    onData,
    onDispose,
    onPasteShortcut,
    onReady,
    onResize,
    onScroll,
  }: UseXtermInstanceOptions,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      fitAddonRef.current?.fit();
      onReady(terminal);
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      terminal.focus();
    }
  }, [onReady, terminalRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
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
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    try {
      terminal.loadAddon(new CanvasAddon());
    } catch {
      // Fall back to the default DOM renderer if canvas is unavailable.
    }
    fitAddon.fit();
    onReady(terminal);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.attachCustomKeyEventHandler((event) => {
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
        onCopyShortcut(terminal);
      } else {
        onPasteShortcut(terminal);
      }
      return false;
    });

    const inputDisposable = terminal.onData(onData);

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      onResize(terminal, cols, rows);
    });

    const scrollDisposable = terminal.onScroll(() => {
      onScroll(terminal);
    });
    const viewport = container.querySelector(".xterm-viewport");
    const handleViewportScroll = () => {
      onScroll(terminal);
    };
    viewport?.addEventListener("scroll", handleViewportScroll, {
      passive: true,
    });

    return () => {
      onDispose();
      viewport?.removeEventListener("scroll", handleViewportScroll);
      scrollDisposable.dispose();
      resizeDisposable.dispose();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    onCopyShortcut,
    onData,
    onDispose,
    onPasteShortcut,
    onReady,
    onResize,
    onScroll,
    terminalRef,
  ]);

  useEffect(() => {
    const target = containerRef.current;
    const fitAddon = fitAddonRef.current;
    if (!target || !fitAddon) {
      return undefined;
    }

    let resizeFrame: number | null = null;
    const fit = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const terminal = terminalRef.current;
        fitAddon.fit();
        if (terminal) {
          onReady(terminal);
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        }
      });
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(target);
    fit();

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver.disconnect();
    };
  }, [onReady, terminalRef]);

  return {
    containerRef,
    fitTerminal,
  };
}
