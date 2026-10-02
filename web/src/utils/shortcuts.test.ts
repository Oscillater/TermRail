import { describe, expect, it } from "vitest";
import { isScrollToBottomShortcut, type ShortcutKeyEvent } from "./shortcuts";

function keydown(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    altKey: false,
    ctrlKey: true,
    key: "End",
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...overrides,
  };
}

describe("isScrollToBottomShortcut", () => {
  it("matches Ctrl+End", () => {
    expect(isScrollToBottomShortcut(keydown())).toBe(true);
  });

  it("tolerates Shift so a shifted press still works", () => {
    expect(isScrollToBottomShortcut(keydown({ shiftKey: true }))).toBe(true);
  });

  it("ignores a bare End so the running program still receives it", () => {
    expect(isScrollToBottomShortcut(keydown({ ctrlKey: false }))).toBe(false);
  });

  it("ignores Alt and Meta combinations", () => {
    expect(isScrollToBottomShortcut(keydown({ altKey: true }))).toBe(false);
    expect(isScrollToBottomShortcut(keydown({ metaKey: true }))).toBe(false);
  });

  it("ignores other Ctrl shortcuts", () => {
    expect(isScrollToBottomShortcut(keydown({ key: "Home" }))).toBe(false);
    expect(isScrollToBottomShortcut(keydown({ key: "a" }))).toBe(false);
  });

  it("ignores keyup events", () => {
    expect(isScrollToBottomShortcut(keydown({ type: "keyup" }))).toBe(false);
  });
});
