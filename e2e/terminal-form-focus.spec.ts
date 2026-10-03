import { expect, test } from "@playwright/test";
import {
  captureInputFrames,
  createTerminal,
  ensureSession,
  openApp,
  refreshSessions,
} from "./helpers";

test.beforeEach(async ({ request }) => {
  await ensureSession(request);
});

test("form owns the keyboard while open", async ({ page, request }) => {
  const frames = captureInputFrames(page);
  await openApp(page);
  await createTerminal(request, "Base", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Base" })).toBeVisible();

  // Focus the terminal first so there is a real focus handover to observe.
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

  await page.getByRole("button", { name: "New terminal" }).click();
  const commandInput = page.locator('input[placeholder="Command"]');
  await expect(commandInput).toBeFocused();

  // Typing goes into the form; the PTY must not receive any of it.
  const framesBefore = frames.length;
  await page.keyboard.type("should-not-reach-pty");
  expect(frames.length).toBe(framesBefore);
  expect(
    await page.evaluate(
      () =>
        document.activeElement?.classList.contains("xterm-helper-textarea") ??
        false,
    ),
  ).toBe(false);
});

test("failed save shows the error and restores focus to the command input", async ({
  page,
  request,
}) => {
  await openApp(page);
  await createTerminal(request, "Base", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Base" })).toBeVisible();

  await page.getByRole("button", { name: "New terminal" }).click();
  const commandInput = page.locator('input[placeholder="Command"]');
  await expect(commandInput).toBeFocused();

  await page.route("**/api/sessions/*/terminals", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "E2E", message: "boom" } }),
      });
      return;
    }
    await route.fallback();
  });

  await page.locator('input[placeholder="Name"]').fill("Broken");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".form-error")).toBeVisible();

  // Focus returns to the command input with its content selected.
  await expect(commandInput).toBeFocused();
  const restoredSelection = await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[placeholder="Command"]',
    );
    return (
      el !== null &&
      el.selectionStart === 0 &&
      el.selectionEnd === el.value.length
    );
  });
  expect(restoredSelection).toBe(true);
});

test("cancel closes the form and returns focus to the terminal", async ({
  page,
  request,
}) => {
  await openApp(page);
  await createTerminal(request, "Base", "");
  await refreshSessions(page);
  await expect(page.getByRole("tab", { name: "Base" })).toBeVisible();

  await page.locator(".terminal-frame").click();
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.locator('input[placeholder="Command"]')).toBeFocused();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.classList.contains("xterm-helper-textarea") ??
          false,
      ),
    )
    .toBe(true);
});
