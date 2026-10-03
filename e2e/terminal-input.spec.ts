import { expect, test } from "@playwright/test";
import {
  captureInputFrames,
  createTerminal,
  ensureSession,
  openApp,
  refreshSessions,
  visibleTerminalText,
} from "./helpers";

test.beforeEach(async ({ request }) => {
  await ensureSession(request);
});

test("keyboard, shift characters, and IME-style input reach the PTY", async ({
  page,
  request,
}) => {
  const frames = captureInputFrames(page);
  await openApp(page);
  await createTerminal(request, "Shell", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Shell" })).toBeVisible();

  await page.locator(".terminal-frame").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.classList.contains("xterm-helper-textarea") ??
          false,
      ),
    )
    .toBe(true);

  // Plain characters, shifted characters, and an IME-style commit must all
  // travel the onData -> WebSocket -> PTY path without being swallowed.
  await page.keyboard.type("abc");
  await page.keyboard.press("Shift+Digit1"); // !
  await page.keyboard.press("Shift+KeyA"); // A
  await page.keyboard.insertText("你好，世界");

  const joined = () => frames.map((frame) => frame.data).join("");
  await expect.poll(joined).toContain("abc");
  await expect.poll(joined).toContain("!");
  await expect.poll(joined).toContain("A");
  await expect.poll(joined).toContain("你好，世界");

  // The shell echoes what was typed; the DOM renderer makes the screen readable.
  await page.keyboard.press("Enter");
  await expect.poll(() => visibleTerminalText(page)).toContain("你好，世界");
});
