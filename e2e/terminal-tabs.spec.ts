import { expect, test } from "@playwright/test";
import {
  captureInputFrames,
  createTerminal,
  ensureSession,
  expectSelectedTerminalRunning,
  openApp,
  refreshSessions,
  visibleTerminalText,
} from "./helpers";

// TermRail already wraps terminal commands in powershell -Command, so the
// command here is the bare loop. Do NOT nest another powershell -Command with
// double quotes: the outer shell would expand $variables before the inner
// powershell ever sees them (while($true) would arrive as while(True)).
const AAA_COMMAND =
  "while($true) { Write-Output ('AAA-' + (Get-Random -Maximum 99999)); Start-Sleep -Milliseconds 300 }";
const BBB_COMMAND =
  "while($true) { Write-Output ('BBB-' + (Get-Random -Maximum 99999)); Start-Sleep -Milliseconds 300 }";

test.beforeEach(async ({ request }) => {
  await ensureSession(request);
});

test("switching tabs keeps each terminal's output and input separate", async ({
  page,
  request,
}) => {
  const frames = captureInputFrames(page);
  await openApp(page);

  const idA = await createTerminal(request, "AAA feed", AAA_COMMAND);
  const idB = await createTerminal(request, "BBB feed", BBB_COMMAND);
  await refreshSessions(page);

  const tabA = page.getByRole("tab", { name: "AAA feed" });
  const tabB = page.getByRole("tab", { name: "BBB feed" });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();

  // The first terminal is selected by default and only shows its own output.
  await expectSelectedTerminalRunning(page, "AAA feed");
  await expect.poll(() => visibleTerminalText(page)).toContain("AAA-");
  const textA = await visibleTerminalText(page);
  expect(textA).not.toContain("BBB-");

  // Switching to the second terminal selects it, updates the footer, and
  // shows only the second terminal's output.
  await tabB.click();
  await expect(tabB).toHaveAttribute("aria-selected", "true");
  await expectSelectedTerminalRunning(page, "BBB feed");
  await expect(page.getByText("Tab BBB feed")).toBeVisible();
  await expect.poll(() => visibleTerminalText(page)).toContain("BBB-");
  const textB = await visibleTerminalText(page);
  expect(textB).not.toContain("AAA-");

  // Typing while BBB is selected reaches only BBB's PTY.
  await page.locator(".terminal-frame").click();
  await page.keyboard.type("hello-B");
  const joinedFor = (terminalId: string) =>
    frames
      .filter((frame) => frame.terminalId === terminalId)
      .map((frame) => frame.data)
      .join("");
  await expect.poll(() => joinedFor(idB)).toContain("hello-B");
  expect(joinedFor(idA)).not.toContain("hello-B");

  // Switching back to AAA: its scrollback is intact and input goes to AAA.
  await tabA.click();
  await expect(tabA).toHaveAttribute("aria-selected", "true");
  await expectSelectedTerminalRunning(page, "AAA feed");
  await expect.poll(() => visibleTerminalText(page)).toContain("AAA-");
  const textAagain = await visibleTerminalText(page);
  expect(textAagain).not.toContain("BBB-");

  await page.locator(".terminal-frame").click();
  await page.keyboard.type("hello-A");
  await expect.poll(() => joinedFor(idA)).toContain("hello-A");
  expect(joinedFor(idB)).not.toContain("hello-A");
});
