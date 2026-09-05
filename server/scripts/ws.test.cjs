const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { createServer } = require("node:http");
const { WebSocket } = require("ws");

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      socket.off("message", handleMessage);
      reject(error);
    };
    const handleMessage = (data) => {
      socket.off("error", handleError);
      resolve(JSON.parse(data.toString()));
    };
    socket.once("error", handleError);
    socket.once("message", handleMessage);
  });
}

function runtimeStatus() {
  return {
    sessionId: "session",
    terminalId: "terminal",
    runtimeId: 1,
    state: "running",
    startedAt: "2026-09-03T00:00:00.000Z",
    stoppedAt: null,
    lastOutputAt: null,
    exitCode: null,
    pid: 123,
    bufferLength: 0,
  };
}

async function main() {
  const { attachWebSocketServer } = await import("../dist/ws.js");
  const server = createServer();
  const sessionManager = new EventEmitter();
  let terminalExists = true;

  sessionManager.getStatus = () => runtimeStatus();
  const configStore = {
    getSession(sessionId) {
      if (sessionId !== "session") {
        return null;
      }
      return {
        id: "session",
        name: "Session",
        cwd: ".",
        prompts: [],
        terminals: terminalExists
          ? [{ id: "terminal", name: "Terminal", command: "cmd" }]
          : [],
      };
    },
  };

  attachWebSocketServer(server, "", configStore, sessionManager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  try {
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        sessionId: "session",
        terminalId: "terminal",
      }),
    );
    assert.equal((await nextMessage(socket)).type, "subscribed");

    terminalExists = false;
    socket.send(
      JSON.stringify({
        type: "unsubscribe",
        sessionId: "session",
        terminalId: "terminal",
      }),
    );
    assert.deepEqual(await nextMessage(socket), {
      type: "unsubscribed",
      sessionId: "session",
      terminalId: "terminal",
    });
  } finally {
    socket.close();
    await once(socket, "close");
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
