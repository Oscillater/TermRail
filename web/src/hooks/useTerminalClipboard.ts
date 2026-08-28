import { useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { readClipboardText, writeClipboardText } from "../utils/clipboard";
import { messageFromError } from "../utils/errors";

export function useTerminalClipboard(
  onError: (message: string | null) => void,
) {
  const copyTerminalSelection = useCallback(
    async (terminal: Terminal) => {
      const selection = terminal.getSelection();
      if (!selection) {
        return;
      }

      try {
        const textarea = terminal.textarea;
        let copied = false;

        if (textarea) {
          const previousValue = textarea.value;
          const previousSelectionStart = textarea.selectionStart;
          const previousSelectionEnd = textarea.selectionEnd;

          textarea.value = selection;
          textarea.focus({ preventScroll: true });
          textarea.select();
          copied = document.execCommand("copy");
          textarea.value = previousValue;

          if (
            previousSelectionStart !== null &&
            previousSelectionEnd !== null
          ) {
            textarea.setSelectionRange(
              previousSelectionStart,
              previousSelectionEnd,
            );
          }
        }

        if (!copied) {
          await writeClipboardText(selection);
        }

        terminal.clearSelection();
        terminal.focus();
        onError(null);
      } catch (error) {
        onError(messageFromError(error, "Failed to copy terminal selection"));
      }
    },
    [onError],
  );

  const pasteTerminalClipboard = useCallback(
    async (terminal: Terminal) => {
      try {
        const text = await readClipboardText();
        if (!text) {
          return;
        }
        terminal.paste(text);
        terminal.focus();
        onError(null);
      } catch (error) {
        onError(messageFromError(error, "Failed to paste clipboard"));
      }
    },
    [onError],
  );

  return {
    copyTerminalSelection,
    pasteTerminalClipboard,
  };
}
