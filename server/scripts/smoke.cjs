const { spawn } = require("node:child_process");
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
      reject(new Error("timeout waiting for no-buffer subscription"));
    }, 3000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          sessionId,
          terminalId: mainTerminalId,
          includeBuffer: false,
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
      if (message.buffer !== "") {
        reject(
          new Error(
            `no-buffer subscription returned ${message.buffer.length} chars`,
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
          `http://127.0.0.1:${port}/api/sessions/${targetSessionId}/start`,
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

function readTerminalSnapshot(
  targetSessionId,
  targetTerminalId = mainTerminalId,
) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for terminal snapshot"));
    }, 3000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          sessionId: targetSessionId,
          terminalId: targetTerminalId,
          includeBuffer: true,
        }),
      );
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "error") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`snapshot failed: ${JSON.stringify(message.error)}`));
        return;
      }
      if (message.type !== "subscribed") {
        return;
      }

      clearTimeout(timeout);
      ws.close();
      if (
        message.sessionId !== targetSessionId ||
        message.terminalId !== targetTerminalId
      ) {
        reject(
          new Error(
            `snapshot returned ${message.sessionId}/${message.terminalId}`,
          ),
        );
        return;
      }
      resolve(message);
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

function terminalsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((terminal, index) => {
      const other = right[index];
      return (
        other &&
        terminal.id === other.id &&
        terminal.name === other.name &&
        terminal.command === other.command
      );
    })
  );
}

function waitForTerminalText(terminalId, expectedText) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
          sessionId,
          terminalId,
          includeBuffer: true,
        }),
      );
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (
        (message.type === "subscribed" || message.type === "terminal.output") &&
        message.terminalId !== terminalId
      ) {
        clearTimeout(timeout);
        ws.close();
        reject(
          new Error(`${message.type} returned terminal ${message.terminalId}`),
        );
        return;
      }
      if (message.type === "subscribed") {
        buffer += message.buffer;
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

async function runDefaultCommandUpdateCheck() {
  const session = await readSession();
  const previousTerminals = session.terminals;
  const updatedCommand = "node -e \"console.log('updated-main')\"";
  const updateResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: session.id,
        name: session.name,
        cwd: session.cwd,
        command: updatedCommand,
        prompts: session.prompts,
      }),
    },
  );
  if (!updateResponse.ok) {
    throw new Error(
      `update default command failed: ${updateResponse.status} ${await updateResponse.text()}`,
    );
  }

  const updated = await updateResponse.json();
  const mainTerminal = updated.session.terminals.find(
    (terminal) => terminal.id === mainTerminalId,
  );
  if (mainTerminal?.command !== updatedCommand) {
    throw new Error(
      `main terminal command was ${JSON.stringify(mainTerminal?.command)}`,
    );
  }
  const otherTerminalsBefore = previousTerminals.filter(
    (terminal) => terminal.id !== mainTerminalId,
  );
  const otherTerminalsAfter = updated.session.terminals.filter(
    (terminal) => terminal.id !== mainTerminalId,
  );
  if (!terminalsEqual(otherTerminalsAfter, otherTerminalsBefore)) {
    throw new Error("default command update changed non-main terminals");
  }

  await runWebSocketCheck({
    expectedDescription: "updated main command output",
    expectedPattern: /updated-main/,
  });
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

async function createSmokeSession(targetSessionId, command) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: targetSessionId,
      name: "Delete Recreate Smoke",
      cwd: ".",
      command,
      prompts: [],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `create session ${targetSessionId} failed: ${response.status} ${await response.text()}`,
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
    await createSmokeSession(
      targetSessionId,
      `node -e "console.log('${oldOutputText}')"`,
    );
    await runWebSocketCheck({
      expectedDescription: "old delete/recreate output",
      expectedPattern: new RegExp(oldOutputText),
      targetSessionId,
    });

    await deleteSessionIfExists(targetSessionId);
    await createSmokeSession(
      targetSessionId,
      `node -e "console.log('${newOutputText}')"`,
    );

    const snapshot = await readTerminalSnapshot(targetSessionId);
    if (snapshot.buffer !== "") {
      throw new Error(
        `recreated session inherited ${snapshot.buffer.length} stale buffer chars`,
      );
    }
    if (
      snapshot.status.state !== "stopped" ||
      snapshot.status.startedAt !== null ||
      snapshot.status.bufferLength !== 0
    ) {
      throw new Error(
        `recreated session status was ${JSON.stringify(snapshot.status)}`,
      );
    }

    const newOutput = await runWebSocketCheck({
      expectedDescription: "new delete/recreate output",
      expectedPattern: new RegExp(newOutputText),
      targetSessionId,
    });
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
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    if (!response.ok) {
      throw new Error(`list sessions failed: ${response.status}`);
    }
    const output = await runWebSocketCheck();
    await runNoBufferSubscriptionCheck();
    await runSecondTerminalCheck();
    await runReadonlyTerminalsUpdateCheck();
    await runDefaultCommandUpdateCheck();
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
