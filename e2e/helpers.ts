import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const E2E_SESSION_ID = "e2e-main";
// Playwright runs from the repo root; the server validates that the cwd exists.
export const E2E_CWD = process.cwd();

export type InputFrame = { terminalId: string; data: string };

/** Seed a dedicated e2e session, replacing whatever a previous run left behind. */
export async function ensureSession(request: APIRequestContext): Promise<void> {
  const deleted = await request.delete(`/api/sessions/${E2E_SESSION_ID}`);
  if (!deleted.ok() && deleted.status() !== 404) {
    throw new Error(
      `failed to clean up previous e2e session: ${deleted.status()} ${await deleted.text()}`,
    );
  }

  const created = await request.post("/api/sessions", {
    data: { id: E2E_SESSION_ID, name: "E2E Main", cwd: E2E_CWD, prompts: [] },
  });
  if (!created.ok()) {
    throw new Error(
      `failed to seed e2e session: ${created.status()} ${await created.text()}`,
    );
  }
}

/** Create a terminal (the server starts it immediately) and return its id. */
export async function createTerminal(
  request: APIRequestContext,
  name: string,
  command = "",
): Promise<string> {
  const response = await request.post(
    `/api/sessions/${E2E_SESSION_ID}/terminals`,
    { data: { name, command } },
  );
  if (!response.ok()) {
    throw new Error(
      `failed to create terminal "${name}": ${response.status()} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { terminal: { id: string } };
  return body.terminal.id;
}

/** Open the app with the DOM renderer so xterm screen text is assertable. */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/?domrenderer=1");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Main" })).toBeVisible();
}

/**
 * Terminals created through the API while the page is open do not push new
 * session config to already-mounted views; the sidebar Refresh button makes
 * the app refetch sessions so externally created terminals show up.
 */
export async function refreshSessions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh" }).click();
}

/** Record every `{type: "input"}` frame the app sends over WebSocket. */
export function captureInputFrames(page: Page): InputFrame[] {
  const frames: InputFrame[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      try {
        const message = JSON.parse(String(frame.payload)) as {
          type?: string;
          terminalId?: string;
          data?: string;
        };
        if (message.type === "input" && message.terminalId) {
          frames.push({
            terminalId: message.terminalId,
            data: message.data ?? "",
          });
        }
      } catch {
        // non-JSON control frames are irrelevant here
      }
    });
  });
  return frames;
}

/** Text currently rendered inside the visible xterm (DOM renderer required). */
export async function visibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host =
      document.querySelector<HTMLElement>(".terminal-host.active") ??
      document.querySelector<HTMLElement>(".terminal-host");
    const rows = host?.querySelector(".xterm-rows");
    return rows ? (rows.textContent ?? "") : "";
  });
}

/** Scroll metrics of the viewport that actually has scrollback. */
export async function readViewportScroll(
  page: Page,
): Promise<{ scrollTop: number; max: number; atBottom: boolean }> {
  return page.evaluate(() => {
    const viewports = [
      ...document.querySelectorAll<HTMLElement>(".xterm-viewport"),
    ];
    const vp =
      viewports.find((v) => v.scrollHeight - v.clientHeight > 50) ??
      viewports[0];
    if (!vp) {
      return { scrollTop: 0, max: 0, atBottom: true };
    }
    const scrollTop = Math.round(vp.scrollTop);
    const max = Math.round(vp.scrollHeight - vp.clientHeight);
    return { scrollTop, max, atBottom: scrollTop >= max - 1 };
  });
}

/**
 * Feed raw keystrokes to a terminal through a dedicated WebSocket, bypassing
 * the UI. Used to build scrollback quickly without typing 500 lines.
 */
export async function sendRawInput(
  page: Page,
  terminalId: string,
  data: string,
): Promise<void> {
  await page.evaluate(
    ({
      sessionId,
      terminalId,
      data,
    }: {
      sessionId: string;
      terminalId: string;
      data: string;
    }) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("raw input websocket timed out"));
        }, 10_000);
        const cleanup = () => clearTimeout(timer);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "subscribe", sessionId, terminalId }));
          ws.send(
            JSON.stringify({ type: "input", sessionId, terminalId, data }),
          );
        });
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === "subscribed") {
            cleanup();
            resolve();
            ws.close();
          }
        });
        ws.addEventListener("error", () => {
          cleanup();
          reject(new Error("raw input websocket failed"));
        });
      }),
    { sessionId: E2E_SESSION_ID, terminalId, data },
  );
}

/**
 * The selected terminal must be alive (footer shows the session-assigned PID)
 * before the test types into it, so input assertions cannot pass vacuously
 * against a terminal that already exited.
 */
export async function expectSelectedTerminalRunning(
  page: Page,
  name: string,
): Promise<void> {
  const footer = page.locator(".terminal-footer");
  await expect.poll(() => footer.textContent()).toContain(`Tab ${name}`);
  await expect.poll(() => footer.textContent()).toMatch(/PID \d+/);
}

export function terminalTab(page: Page, name: string) {
  return page.getByRole("tab", { name });
}
