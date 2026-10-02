export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
>;

/**
 * True when the event is the shortcut that scrolls the active terminal to the
 * bottom: `Ctrl+End` on a keydown. Shift is tolerated so a shifted press still
 * works, while Alt and Meta belong to the browser and the running program.
 */
export function isScrollToBottomShortcut(event: ShortcutKeyEvent): boolean {
  if (event.type !== "keydown") {
    return false;
  }

  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  return event.key === "End";
}
