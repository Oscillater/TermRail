import { expect, test } from "@playwright/test";
import {
  createTerminal,
  ensureSession,
  openApp,
  readViewportScroll,
  refreshSessions,
  sendRawInput,
  visibleTerminalText,
} from "./helpers";

const LINES_COMMAND = '1..500 | ForEach-Object { "line-$_" }\r';

test.beforeEach(async ({ request }) => {
  await ensureSession(request);
});

test("Ctrl+End jumps to the bottom with focus outside the terminal", async ({
  page,
  request,
}) => {
  await openApp(page);
  const terminalId = await createTerminal(request, "Scroll", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Scroll" })).toBeVisible();

  // Focus the terminal and build scrollback quickly.
  await page.locator(".terminal-frame").click();
  await sendRawInput(page, terminalId, LINES_COMMAND).catch(() => undefined);
  await expect.poll(() => visibleTerminalText(page)).toContain("line-500");
  await expect
    .poll(async () => (await readViewportScroll(page)).atBottom)
    .toBe(true);

  // Scroll up into the middle, like a user wheeling back through history.
  await page.evaluate(() => {
    const viewports = [
      ...document.querySelectorAll<HTMLElement>(".xterm-viewport"),
    ];
    const vp = viewports.find((v) => v.scrollHeight - v.clientHeight > 50);
    if (vp) {
      vp.scrollTop = Math.round((vp.scrollHeight - vp.clientHeight) / 2);
    }
  });
  await expect
    .poll(async () => (await readViewportScroll(page)).atBottom)
    .toBe(false);

  // Move focus off the terminal, then press Ctrl+End through the real input path.
  await page.getByRole("heading", { name: "Sessions" }).click();
  await page.keyboard.press("Control+End");
  await expect
    .poll(async () => (await readViewportScroll(page)).atBottom)
    .toBe(true);

  // The jump must stick even while output keeps arriving.
  await page.waitForTimeout(800);
  expect((await readViewportScroll(page)).atBottom).toBe(true);
});

test("Ctrl+End inside a text field keeps the field behavior", async ({
  page,
  request,
}) => {
  await openApp(page);
  const terminalId = await createTerminal(request, "Scroll", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Scroll" })).toBeVisible();

  await page.locator(".terminal-frame").click();
  await sendRawInput(page, terminalId, LINES_COMMAND).catch(() => undefined);
  await expect.poll(() => visibleTerminalText(page)).toContain("line-500");

  await page.evaluate(() => {
    const viewports = [
      ...document.querySelectorAll<HTMLElement>(".xterm-viewport"),
    ];
    const vp = viewports.find((v) => v.scrollHeight - v.clientHeight > 50);
    if (vp) {
      vp.scrollTop = Math.round((vp.scrollHeight - vp.clientHeight) / 2);
    }
  });
  await expect
    .poll(async () => (await readViewportScroll(page)).atBottom)
    .toBe(false);

  // With focus in a text field, Ctrl+End belongs to the field, not the terminal.
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.locator('input[placeholder="Command"]')).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  expect((await readViewportScroll(page)).atBottom).toBe(false);
});

test("reloading reaches Ready again and keeps the last screen", async ({
  page,
  request,
}) => {
  await openApp(page);
  const terminalId = await createTerminal(request, "Reload", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: /Reload/ })).toBeVisible();

  await page.locator(".terminal-frame").click();
  await sendRawInput(page, terminalId, LINES_COMMAND).catch(() => undefined);
  await expect.poll(() => visibleTerminalText(page)).toContain("line-500");

  await page.reload();
  // The snapshot handshake must complete instead of getting stuck on Loading.
  await expect(page.getByText("Loading terminal...")).toBeHidden({
    timeout: 30_000,
  });
  // The tail snapshot keeps the last screen (the 500-line run + prompt).
  await expect.poll(() => visibleTerminalText(page)).toContain("line-500");
});
