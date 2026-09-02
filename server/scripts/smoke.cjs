const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFile, mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const projectRoot = path.resolve(__dirname, "..", "..");
const port = Number(process.env.SMOKE_PORT || "8797");
const sessionId = "test-node-version";
const mainTerminalId = "main";
const serverEntry = path.join(projectRoot, "server", "dist", "index.js");
const exampleConfigPath = path.join(projectRoot, "data", "config.example.json");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForOutput(readOutput, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) {
      return true;
    }
    await wait(25);
  }
  return readOutput().includes(expected);
}

function waitForProcessClose(child, isClosed, timeoutMs) {
  if (isClosed()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);

    function finish(closed) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(closed);
    }

    function onClose() {
      finish(true);
    }

    function onError() {
      finish(true);
    }

    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function terminateServer(child, isClosed) {
  if (isClosed()) {
    return;
  }

  const gracefulClose = waitForProcessClose(child, isClosed, 5000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  if (await gracefulClose) {
    return;
  }

  const forcedClose = waitForProcessClose(child, isClosed, 2000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await forcedClose;
}

function filterKnownWindowsPtyCleanupNoise(stderr) {
  if (
    process.platform !== "win32" ||
    !stderr.includes("AttachConsole failed") ||
    !stderr.includes("conpty_console_list_agent")
  ) {
    return stderr;
  }

  const conptyAgentLine =
    /node_modules[\\/]+node-pty[\\/]+lib[\\/]+conpty_console_list_agent\.js:\d+/;
  const nodeVersionLine = /^Node\.js v\d+\.\d+\.\d+/;
  const lines = stderr.split(/\r?\n/);
  const filtered = [];

  for (let index = 0; index < lines.length;) {
    if (!conptyAgentLine.test(lines[index])) {
      filtered.push(lines[index]);
      index += 1;
      continue;
    }

    const blockStart = index;
    let blockEnd = index;
    let isKnownCleanupNoise = false;
    let sawNodeVersionLine = false;

    while (blockEnd < lines.length) {
      if (lines[blockEnd].includes("Error: AttachConsole failed")) {
        isKnownCleanupNoise = true;
      }
      blockEnd += 1;
      if (nodeVersionLine.test(lines[blockEnd - 1])) {
        sawNodeVersionLine = true;
        break;
      }
    }

    if (isKnownCleanupNoise && sawNodeVersionLine) {
      index = blockEnd;
      continue;
    }

    filtered.push(...lines.slice(blockStart, blockEnd));
    index = blockEnd;
  }

  return filtered.join("\n").trimEnd();
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await wait(250);
  }
  throw new Error("server did not become ready");
}

function runNoBufferSubscriptionCheck() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for subscription"));
    }, 3000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          sessionId,
          terminalId: mainTerminalId,
        }),
      );
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "subscribed") {
        return;
      }

      clearTimeout(timeout);
      ws.close();
      if (message.terminalId !== mainTerminalId) {
        reject(new Error(`subscribed returned terminal ${message.terminalId}`));
        return;
      }
      if ("buffer" in message) {
        reject(
          new Error(
            `subscription unexpectedly returned ${
              message.data?.length ?? 0
            } chars`,
          ),
        );
        return;
      }
      resolve();
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function runWebSocketCheck({
  expectedDescription = "Node version",
  expectedPattern = /v\d+\.\d+\.\d+/,
  targetSessionId = sessionId,
  targetTerminalId = mainTerminalId,
} = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    let completed = false;
    let sawOutputTimestamp = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `timeout waiting for PTY output; output=${JSON.stringify(output)}`,
        ),
      );
    }, 8000);

    ws.on("open", async () => {
      try {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            sessionId: targetSessionId,
            terminalId: targetTerminalId,
          }),
        );
        const response = await fetch(
          `http://127.0.0.1:${port}/api/sessions/${targetSessionId}/terminals/${targetTerminalId}/start`,
          {
            method: "POST",
          },
        );
        if (!response.ok) {
          throw new Error(
            `start failed: ${response.status} ${await response.text()}`,
          );
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "terminal.output") {
        if (message.terminalId !== targetTerminalId) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`output returned terminal ${message.terminalId}`));
          return;
        }
        if (
          typeof message.at !== "string" ||
          Number.isNaN(Date.parse(message.at))
        ) {
          clearTimeout(timeout);
          ws.close();
          reject(
            new Error("terminal output did not include a valid timestamp"),
          );
          return;
        }
        sawOutputTimestamp = true;
        output += message.data;
      }
      if (
        message.type === "session.status" &&
        message.status.state === "stopped"
      ) {
        completed = true;
        clearTimeout(timeout);
        ws.close();
      }
    });

    ws.on("close", () => {
      if (completed && sawOutputTimestamp && expectedPattern.test(output)) {
        resolve(output.trim());
        return;
      }
      reject(
        new Error(
          `PTY output did not include ${expectedDescription}; output=${JSON.stringify(output)}`,
        ),
      );
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function readSession(targetSessionId = sessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  if (!response.ok) {
    throw new Error(`list sessions failed: ${response.status}`);
  }

  const data = await response.json();
  const session = data.sessions.find((item) => item.id === targetSessionId);
  if (!session) {
    throw new Error(`session ${targetSessionId} was not found`);
  }
  return session;
}

function waitForTerminalText(
  terminalId,
  expectedText,
  targetSessionId = sessionId,
) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const snapshotRequestId = `wait-text:${Date.now()}`;
    let buffer = "";
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `timeout waiting for ${expectedText}; buffer=${JSON.stringify(buffer)}`,
        ),
      );
    }, 3000);

    const maybeResolve = () => {
      if (!buffer.includes(expectedText)) {
        return false;
      }
      clearTimeout(timeout);
      ws.close();
      resolve(buffer);
      return true;
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          sessionId: targetSessionId,
          terminalId,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: targetSessionId,
          terminalId,
          requestId: snapshotRequestId,
          cols: 80,
          rows: 24,
        }),
      );
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (
        (message.type === "subscribed" ||
          message.type === "terminal.snapshot" ||
          message.type === "terminal.output") &&
        message.terminalId !== terminalId
      ) {
        clearTimeout(timeout);
        ws.close();
        reject(
          new Error(`${message.type} returned terminal ${message.terminalId}`),
        );
        return;
      }
      if (
        message.type === "terminal.snapshot" &&
        message.requestId === snapshotRequestId
      ) {
        buffer += message.data;
        maybeResolve();
      }
      if (message.type === "terminal.output") {
        buffer += message.data;
        maybeResolve();
      }
      if (
        message.type === "terminal.status" &&
        message.terminalId === terminalId &&
        message.status.state === "stopped" &&
        !maybeResolve()
      ) {
        clearTimeout(timeout);
        ws.close();
        reject(
          new Error(
            `terminal stopped before ${expectedText}; buffer=${JSON.stringify(
              buffer,
            )}`,
          ),
        );
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runReadonlyTerminalsUpdateCheck() {
  let terminalId = null;
  try {
    const createResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Readonly Guard",
          command:
            "node -e \"setTimeout(() => console.log('guard-done'), 20000)\"",
        }),
      },
    );
    if (!createResponse.ok) {
      throw new Error(
        `create guard terminal failed: ${createResponse.status} ${await createResponse.text()}`,
      );
    }

    const created = await createResponse.json();
    terminalId = created.terminal.id;
    const attemptedSession = {
      ...created.session,
      terminals: created.session.terminals.filter(
        (terminal) => terminal.id !== terminalId,
      ),
    };
    const updateResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attemptedSession),
      },
    );
    if (updateResponse.status !== 400) {
      throw new Error(
        `readonly terminals update returned ${updateResponse.status}`,
      );
    }

    const updateError = await updateResponse.json();
    if (updateError.error?.code !== "TERMINALS_READ_ONLY") {
      throw new Error(
        `readonly terminals update returned ${JSON.stringify(updateError)}`,
      );
    }

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals`,
    );
    if (!listResponse.ok) {
      throw new Error(`list terminals failed: ${listResponse.status}`);
    }
    const listed = await listResponse.json();
    if (!listed.terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(
        "guard terminal disappeared after rejected session update",
      );
    }
    if (listed.statuses[terminalId]?.state !== "running") {
      throw new Error(
        `guard terminal status was ${JSON.stringify(listed.statuses[terminalId])}`,
      );
    }

    const editResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changed While Running",
          command: "node -e \"console.log('must-not-run')\"",
        }),
      },
    );
    if (editResponse.status !== 409) {
      throw new Error(`running terminal edit returned ${editResponse.status}`);
    }
    const editError = await editResponse.json();
    if (editError.error?.code !== "TERMINAL_RUNNING") {
      throw new Error(
        `running terminal edit returned ${JSON.stringify(editError)}`,
      );
    }
    const unchangedSession = await readSession();
    const unchangedTerminal = unchangedSession.terminals.find(
      (terminal) => terminal.id === terminalId,
    );
    if (
      unchangedTerminal?.name !== created.terminal.name ||
      unchangedTerminal.command !== created.terminal.command
    ) {
      throw new Error(
        `running terminal edit changed config to ${JSON.stringify(unchangedTerminal)}`,
      );
    }
  } finally {
    if (terminalId) {
      const deleteResponse = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
        { method: "DELETE" },
      );
      if (!deleteResponse.ok) {
        throw new Error(
          `delete guard terminal failed: ${deleteResponse.status} ${await deleteResponse.text()}`,
        );
      }
    }
  }
}

async function runTerminalUpdateCheck() {
  const session = await readSession();
  const updatedCommand = "node -e \"console.log('updated-terminal')\"";
  const updateResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${mainTerminalId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Main",
        command: updatedCommand,
      }),
    },
  );
  if (!updateResponse.ok) {
    throw new Error(
      `update terminal failed: ${updateResponse.status} ${await updateResponse.text()}`,
    );
  }

  const updated = await updateResponse.json();
  if (
    updated.terminal.command !== updatedCommand ||
    updated.terminal.name !== "Updated Main"
  ) {
    throw new Error(`updated terminal was ${JSON.stringify(updated.terminal)}`);
  }
  if (Object.hasOwn(updated.session, "command")) {
    throw new Error("updated session still exposed a command");
  }

  await runWebSocketCheck({
    expectedDescription: "updated terminal command output",
    expectedPattern: /updated-terminal/,
  });
}

function runMissingTerminalIdCheck() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for missing terminal id error"));
    }, 3000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "error") {
        return;
      }
      clearTimeout(timeout);
      ws.close();
      if (message.error?.code !== "INVALID_WS_MESSAGE") {
        reject(
          new Error(`missing terminal id returned ${JSON.stringify(message)}`),
        );
        return;
      }
      resolve();
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function expectHttpError(response, expectedStatus, expectedCode, label) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} returned ${response.status}, expected ${expectedStatus}: ${text}`,
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON error body: ${text}`);
  }

  if (body.error?.code !== expectedCode) {
    throw new Error(
      `${label} returned ${JSON.stringify(body)}, expected ${expectedCode}`,
    );
  }
}

function expectWebSocketError(payload, expectedCode, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout waiting for ${label} WebSocket error`));
    }, 3000);

    ws.on("open", () => {
      ws.send(JSON.stringify(payload));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      clearTimeout(timeout);
      ws.close();
      if (message.type !== "error" || message.error?.code !== expectedCode) {
        reject(
          new Error(
            `${label} WebSocket returned ${JSON.stringify(message)}, expected ${expectedCode}`,
          ),
        );
        return;
      }
      resolve();
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function assertTerminalActionsRejected(terminalId, label) {
  for (const action of ["start", "stop"]) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}/${action}`,
      { method: "POST" },
    );
    await expectHttpError(
      response,
      404,
      "TERMINAL_NOT_FOUND",
      `${label} HTTP ${action}`,
    );
  }

  await expectWebSocketError(
    { type: "input", sessionId, terminalId, data: "ignored" },
    "TERMINAL_NOT_FOUND",
    `${label} input`,
  );
  await expectWebSocketError(
    { type: "resize", sessionId, terminalId, cols: 80, rows: 24 },
    "TERMINAL_NOT_FOUND",
    `${label} resize`,
  );
}

async function runTerminalActionGuardCheck() {
  await assertTerminalActionsRejected(
    "missing-terminal-smoke",
    "missing terminal",
  );

  const terminalId = "deleted-terminal-smoke";
  await deleteTerminalIfExists(terminalId);
  await createSmokeTerminal(
    sessionId,
    "node -e \"console.log('delete-guard')\"",
    { id: terminalId, name: "Deleted Terminal Guard" },
  );
  await deleteTerminal(terminalId);
  await assertTerminalActionsRejected(terminalId, "deleted terminal");
}

async function runRemovedSessionActionsCheck() {
  for (const action of ["start", "stop"]) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/${action}`,
      { method: "POST" },
    );
    if (response.status !== 404) {
      throw new Error(`removed session ${action} returned ${response.status}`);
    }
  }
}

async function deleteSessionIfExists(targetSessionId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${targetSessionId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `delete session ${targetSessionId} failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function createSmokeSession(targetSessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: targetSessionId,
      name: "Delete Recreate Smoke",
      cwd: ".",
      prompts: [],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `create session ${targetSessionId} failed: ${response.status} ${await response.text()}`,
    );
  }
  const created = await response.json();
  if (
    Object.hasOwn(created.session, "command") ||
    created.session.terminals.length !== 0
  ) {
    throw new Error(
      `new session was not empty: ${JSON.stringify(created.session)}`,
    );
  }
  return created.session;
}

async function createSmokeTerminal(targetSessionId, command, options = {}) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${targetSessionId}/terminals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: options.id,
        name: options.name ?? "Smoke Terminal",
        command,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `create terminal for ${targetSessionId} failed: ${response.status} ${await response.text()}`,
    );
  }
  return await response.json();
}

async function runDeleteRecreateSessionCleanupCheck() {
  const targetSessionId = "smoke-delete-recreate";
  const oldOutputText = "delete-recreate-old";
  const newOutputText = "delete-recreate-new";

  await deleteSessionIfExists(targetSessionId);
  try {
    await createSmokeSession(targetSessionId);
    const oldTerminal = await createSmokeTerminal(
      targetSessionId,
      `node -e "console.log('${oldOutputText}')"`,
    );
    await waitForTerminalText(
      oldTerminal.terminal.id,
      oldOutputText,
      targetSessionId,
    );

    await deleteSessionIfExists(targetSessionId);
    await createSmokeSession(targetSessionId);
    const recreatedSession = await readSession(targetSessionId);
    if (recreatedSession.terminals.length !== 0) {
      throw new Error("recreated session inherited deleted terminals");
    }

    const newTerminal = await createSmokeTerminal(
      targetSessionId,
      `node -e "console.log('${newOutputText}')"`,
    );
    const newOutput = await waitForTerminalText(
      newTerminal.terminal.id,
      newOutputText,
      targetSessionId,
    );
    if (newOutput.includes(oldOutputText)) {
      throw new Error("recreated session output included deleted session text");
    }
  } finally {
    await deleteSessionIfExists(targetSessionId).catch(() => undefined);
  }
}

async function runSecondTerminalCheck() {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Second",
        command: "node -e \"console.log('second-terminal')\"",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `create terminal failed: ${response.status} ${await response.text()}`,
    );
  }

  const created = await response.json();
  const terminalId = created.terminal.id;
  const buffer = await waitForTerminalText(terminalId, "second-terminal");
  if (!buffer.includes("second-terminal")) {
    throw new Error(`second terminal buffer was ${JSON.stringify(buffer)}`);
  }
  if (/v\d+\.\d+\.\d+/.test(buffer)) {
    throw new Error("second terminal buffer included main terminal output");
  }

  const deleteResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
    { method: "DELETE" },
  );
  if (!deleteResponse.ok) {
    throw new Error(
      `delete terminal failed: ${deleteResponse.status} ${await deleteResponse.text()}`,
    );
  }

  const listResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals`,
  );
  if (!listResponse.ok) {
    throw new Error(`list terminals failed: ${listResponse.status}`);
  }
  const listed = await listResponse.json();
  if (listed.terminals.some((terminal) => terminal.id === terminalId)) {
    throw new Error("deleted terminal remained in terminal list");
  }
}

async function stopTerminal(terminalId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}/stop`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(
      `stop terminal failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function deleteTerminal(terminalId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(
      `delete terminal failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function deleteTerminalIfExists(terminalId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `delete terminal ${terminalId} failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function runDeleteRecreateTerminalCleanupCheck() {
  const terminalId = "smoke-recreated-terminal";
  const oldMarker = "recreated-terminal-old";
  const newMarker = "recreated-terminal-new";

  await deleteTerminalIfExists(terminalId);
  try {
    await createSmokeTerminal(
      sessionId,
      `node -e "console.log('${oldMarker}')"`,
      { id: terminalId, name: "Recreated Terminal" },
    );
    const oldBuffer = await waitForTerminalText(terminalId, oldMarker);
    if (!oldBuffer.includes(oldMarker)) {
      throw new Error(`old terminal buffer was ${JSON.stringify(oldBuffer)}`);
    }

    await deleteTerminal(terminalId);
    await createSmokeTerminal(
      sessionId,
      `node -e "console.log('${newMarker}')"`,
      { id: terminalId, name: "Recreated Terminal" },
    );
    const newBuffer = await waitForTerminalText(terminalId, newMarker);
    if (newBuffer.includes(oldMarker)) {
      throw new Error(
        `recreated terminal inherited old output: ${JSON.stringify(newBuffer)}`,
      );
    }
  } finally {
    await deleteTerminalIfExists(terminalId).catch(() => undefined);
  }
}

async function runConcurrentStartCheck() {
  const created = await createSmokeTerminal(
    sessionId,
    `node -e "setInterval(()=>{},1000)"`,
  );
  const terminalId = created.terminal.id;

  try {
    await stopTerminal(terminalId);
    const startUrl = `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}/start`;
    const responses = await Promise.all([
      fetch(startUrl, { method: "POST" }),
      fetch(startUrl, { method: "POST" }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    if (statuses[0] !== 200 || statuses[1] !== 409) {
      throw new Error(
        `concurrent starts returned ${responses.map((response) => response.status).join(", ")}`,
      );
    }

    const conflict = responses.find((response) => response.status === 409);
    const body = await conflict.json();
    if (body.error?.code !== "TERMINAL_RUNNING") {
      throw new Error(`concurrent start returned ${JSON.stringify(body)}`);
    }
  } finally {
    await deleteTerminal(terminalId);
  }
}

async function runConcurrentUpdateStartCheck() {
  const oldMarker = "concurrent-command-old";
  const newMarker = "concurrent-command-new";
  const oldCommand = `node -e "console.log('${oldMarker}');setInterval(()=>{},1000)"`;
  const newCommand = `node -e "console.log('${newMarker}');setInterval(()=>{},1000)"`;
  const created = await createSmokeTerminal(sessionId, oldCommand);
  const terminalId = created.terminal.id;

  try {
    await stopTerminal(terminalId);
    const terminalUrl = `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`;
    const [updateResponse, startResponse] = await Promise.all([
      fetch(terminalUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Concurrent Update",
          command: newCommand,
        }),
      }),
      fetch(`${terminalUrl}/start`, { method: "POST" }),
    ]);

    if (!startResponse.ok) {
      throw new Error(
        `concurrent start failed: ${startResponse.status} ${await startResponse.text()}`,
      );
    }

    let expectedCommand;
    let expectedMarker;
    if (updateResponse.ok) {
      expectedCommand = newCommand;
      expectedMarker = newMarker;
    } else {
      const body = await updateResponse.json();
      if (
        updateResponse.status !== 409 ||
        body.error?.code !== "TERMINAL_RUNNING"
      ) {
        throw new Error(
          `concurrent update returned ${updateResponse.status} ${JSON.stringify(body)}`,
        );
      }
      expectedCommand = oldCommand;
      expectedMarker = oldMarker;
    }

    await waitForTerminalText(terminalId, expectedMarker);
    const session = await readSession();
    const terminal = session.terminals.find((item) => item.id === terminalId);
    if (terminal?.command !== expectedCommand) {
      throw new Error(
        `running command and saved command diverged: ${JSON.stringify(terminal)}`,
      );
    }
  } finally {
    await deleteTerminal(terminalId);
  }
}

async function runBracketedPasteCheck() {
  const paste = "\x1b[200~first line\rsecond 中文行\x1b[201~";
  const expectedMarker = `PASTE_HEX:${Buffer.from(paste, "utf8").toString("hex")}`;
  const command =
    "node -e \"let b=Buffer.alloc(0);process.stdin.setRawMode(true);process.stdin.on('data',d=>{b=Buffer.concat([b,d]);if(b.includes(Buffer.from('\\x1b[201~'))){console.log('PASTE_HEX:'+b.toString('hex'));process.exit(0)}});console.log('paste-ready')\"";
  const created = await createSmokeTerminal(sessionId, command);
  const terminalId = created.terminal.id;

  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const snapshotRequestId = `paste:${Date.now()}`;
      let buffer = "";
      let sent = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            `timeout waiting for bracketed paste marker; buffer=${JSON.stringify(buffer)}`,
          ),
        );
      }, 5000);

      const inspectBuffer = () => {
        if (!sent && buffer.includes("paste-ready")) {
          sent = true;
          ws.send(
            JSON.stringify({
              type: "input",
              sessionId,
              terminalId,
              data: paste,
            }),
          );
        }
        if (!buffer.includes(expectedMarker)) {
          return false;
        }
        clearTimeout(timeout);
        ws.close();
        resolve();
        return true;
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            sessionId,
            terminalId,
          }),
        );
        ws.send(
          JSON.stringify({
            type: "snapshot",
            sessionId,
            terminalId,
            requestId: snapshotRequestId,
            cols: 80,
            rows: 24,
          }),
        );
      });
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (
          message.type === "terminal.snapshot" &&
          message.requestId === snapshotRequestId
        ) {
          buffer += message.data;
          inspectBuffer();
        }
        if (message.type === "terminal.output") {
          buffer += message.data;
          inspectBuffer();
        }
        if (
          message.type === "terminal.status" &&
          message.terminalId === terminalId &&
          message.status.state === "stopped" &&
          !inspectBuffer()
        ) {
          clearTimeout(timeout);
          ws.close();
          reject(
            new Error(
              `bracketed paste terminal stopped before marker; buffer=${JSON.stringify(buffer)}`,
            ),
          );
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await deleteTerminal(terminalId);
  }
}

async function runUnicodeInputCheck() {
  const repeatedPunctuation = "\u201d\u201d";
  const input = '中文输入、……——“”‘’/^ - "';
  const expectedMarker = `UNICODE_HEX:${Buffer.from(input, "utf8").toString("hex")}`;
  const submittedInput = `\x7f\x7f${input}\r`;
  const command =
    "node -e \"process.stdin.setEncoding('utf8');process.stdin.once('data',data=>{console.log('UNICODE_HEX:'+Buffer.from(data.trim(),'utf8').toString('hex'));process.exit(0)});console.log('unicode-ready')\"";

  const createResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unicode Input", command }),
    },
  );
  if (!createResponse.ok) {
    throw new Error(
      `create Unicode terminal failed: ${createResponse.status} ${await createResponse.text()}`,
    );
  }

  const created = await createResponse.json();
  const terminalId = created.terminal.id;
  const expectedHelperTrace = `sha256=${sha256(submittedInput)}`;

  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const snapshotRequestId = `unicode:${Date.now()}`;
      let buffer = "";
      let inputSent = false;
      let inputSubmitted = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            `timeout waiting for Unicode input marker; buffer=${JSON.stringify(buffer)}`,
          ),
        );
      }, 8000);

      const inspectBuffer = () => {
        if (!inputSent && buffer.includes("unicode-ready")) {
          inputSent = true;
          ws.send(
            JSON.stringify({
              type: "input",
              sessionId,
              terminalId,
              data: repeatedPunctuation,
            }),
          );
        }
        if (
          inputSent &&
          !inputSubmitted &&
          buffer.includes(repeatedPunctuation)
        ) {
          inputSubmitted = true;
          ws.send(
            JSON.stringify({
              type: "input",
              sessionId,
              terminalId,
              data: submittedInput,
            }),
          );
        }
        if (buffer.includes(expectedMarker)) {
          clearTimeout(timeout);
          ws.close();
          resolve();
          return true;
        }
        return false;
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            sessionId,
            terminalId,
          }),
        );
        ws.send(
          JSON.stringify({
            type: "snapshot",
            sessionId,
            terminalId,
            requestId: snapshotRequestId,
            cols: 80,
            rows: 24,
          }),
        );
      });

      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (
          message.type === "terminal.snapshot" &&
          message.requestId === snapshotRequestId
        ) {
          buffer += message.data;
          inspectBuffer();
        }
        if (message.type === "terminal.output") {
          buffer += message.data;
          inspectBuffer();
        }
        if (
          message.type === "terminal.status" &&
          message.terminalId === terminalId &&
          message.status.state === "stopped" &&
          !inspectBuffer()
        ) {
          clearTimeout(timeout);
          ws.close();
          reject(
            new Error(
              `Unicode terminal stopped before marker; buffer=${JSON.stringify(buffer)}`,
            ),
          );
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    const deleteResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/terminals/${terminalId}`,
      { method: "DELETE" },
    );
    if (!deleteResponse.ok) {
      throw new Error(
        `delete Unicode terminal failed: ${deleteResponse.status} ${await deleteResponse.text()}`,
      );
    }
  }

  return expectedHelperTrace;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "termrail-smoke-"));
  const configPath = path.join(tempDir, "config.json");
  await copyFile(exampleConfigPath, configPath);

  const server = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_PATH: configPath,
      TERMRAIL_WINDOWS_PTY: "",
      TERMRAIL_TRACE_WINDOWS_INPUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverStdout = "";
  let serverStderr = "";
  let serverClosed = false;
  server.stdout.on("data", (chunk) => {
    serverStdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });
  server.on("close", () => {
    serverClosed = true;
  });

  try {
    await waitForHealth();
    if (
      process.platform === "win32" &&
      !serverStdout.includes("[server] PTY backend: conpty")
    ) {
      throw new Error(
        `server did not select the default ConPTY backend; stdout=${JSON.stringify(serverStdout)}`,
      );
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    if (!response.ok) {
      throw new Error(`list sessions failed: ${response.status}`);
    }
    const listed = await response.json();
    if (listed.sessions.some((item) => Object.hasOwn(item, "command"))) {
      throw new Error("session list still exposed session commands");
    }
    const output = await runWebSocketCheck();
    await runNoBufferSubscriptionCheck();
    await runMissingTerminalIdCheck();
    await runTerminalActionGuardCheck();
    await runRemovedSessionActionsCheck();
    await runSecondTerminalCheck();
    await runDeleteRecreateTerminalCleanupCheck();
    await runConcurrentStartCheck();
    await runConcurrentUpdateStartCheck();
    await runBracketedPasteCheck();
    const unicodeInputHelperTrace = await runUnicodeInputCheck();
    if (
      process.platform === "win32" &&
      !(await waitForOutput(() => serverStdout, unicodeInputHelperTrace))
    ) {
      throw new Error(
        `Windows console input helper did not acknowledge the Unicode smoke request (${unicodeInputHelperTrace}); stdout=${JSON.stringify(serverStdout)} stderr=${JSON.stringify(serverStderr)}`,
      );
    }
    await runReadonlyTerminalsUpdateCheck();
    await runTerminalUpdateCheck();
    await runDeleteRecreateSessionCleanupCheck();
    console.log(`smoke ok: ${sessionId} output ${JSON.stringify(output)}`);
  } finally {
    await terminateServer(server, () => serverClosed);
    await rm(tempDir, { force: true, recursive: true });
    if (serverStdout.trim()) {
      console.log(serverStdout.trim());
    }
    const filteredStderr = filterKnownWindowsPtyCleanupNoise(serverStderr);
    if (filteredStderr.trim()) {
      console.error(filteredStderr.trim());
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
