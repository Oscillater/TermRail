const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

const projectRoot = path.resolve(__dirname, "..", "..");
const port = Number(process.env.SMOKE_PORT || "8797");
const sessionId = "test-node-version";
const serverEntry = path.join(projectRoot, "server", "dist", "index.js");
const configPath = path.join(projectRoot, "data", "config.example.json");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function runWebSocketCheck() {
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
        ws.send(JSON.stringify({ type: "subscribe", sessionId }));
        const response = await fetch(
          `http://127.0.0.1:${port}/api/sessions/${sessionId}/start`,
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
      if (completed && sawOutputTimestamp && /v\d+\.\d+\.\d+/.test(output)) {
        resolve(output.trim());
        return;
      }
      reject(
        new Error(
          `PTY output did not include a Node version; output=${JSON.stringify(output)}`,
        ),
      );
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
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
  server.stdout.on("data", (chunk) => {
    serverStdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });

  try {
    await waitForHealth();
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    if (!response.ok) {
      throw new Error(`list sessions failed: ${response.status}`);
    }
    const output = await runWebSocketCheck();
    await runNoBufferSubscriptionCheck();
    console.log(`smoke ok: ${sessionId} output ${JSON.stringify(output)}`);
  } finally {
    server.kill();
    await wait(250);
    if (serverStdout.trim()) {
      console.log(serverStdout.trim());
    }
    if (serverStderr.trim()) {
      console.error(serverStderr.trim());
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
