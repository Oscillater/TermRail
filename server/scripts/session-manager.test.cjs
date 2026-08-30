const assert = require("node:assert/strict");

class FakePty {
  constructor(pid) {
    this.pid = pid;
    this.dataListeners = [];
    this.exitListeners = [];
    this.kills = 0;
    this.writes = [];
  }

  onData(listener) {
    this.dataListeners.push(listener);
    return { dispose() {} };
  }

  onExit(listener) {
    this.exitListeners.push(listener);
    return { dispose() {} };
  }

  kill() {
    this.kills += 1;
  }

  write(data) {
    this.writes.push(String(data));
  }

  resize() {}

  emitData(data) {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode = 0) {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

function createPtyFactory() {
  const terminals = [];
  return {
    terminals,
    spawn() {
      const terminal = new FakePty(1000 + terminals.length);
      terminals.push(terminal);
      return terminal;
    },
  };
}

function sessionConfig() {
  return {
    id: "session-a",
    name: "Session A",
    cwd: ".",
    terminals: [
      { id: "terminal-a", name: "Terminal A", command: "test-command" },
    ],
    prompts: [],
  };
}

async function rejectionOf(promise) {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error) => error,
  );
}

async function testStaleRuntimeCallbacks(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    stopTimeoutMs: 20,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const output = [];
  let statuses = 0;
  manager.on("output", (event) => output.push(event.data));
  manager.on("status", () => {
    statuses += 1;
  });

  await manager.start(session, terminalConfig);
  const oldTerminal = factory.terminals[0];
  oldTerminal.emitExit(0);
  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  const newTerminal = factory.terminals[1];
  newTerminal.emitData("new output");

  const statusCountBeforeStaleCallbacks = statuses;
  oldTerminal.emitData("stale output");
  oldTerminal.emitExit(99);

  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "new output");
  assert.deepEqual(output, ["new output"]);
  assert.equal(statuses, statusCountBeforeStaleCallbacks);
  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "running",
  );
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);

  newTerminal.emitExit(0);
}

async function testStopTimeoutAndDeletion(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    stopTimeoutMs: 5,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  for (const operation of [
    () => manager.stop(session.id, terminalConfig.id),
    () => manager.deleteTerminalRuntime(session.id, terminalConfig.id),
    () => manager.deleteSessionRuntime(session.id),
  ]) {
    const error = await rejectionOf(operation());
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "PTY_STOP_TIMEOUT");
    assert.equal(
      manager.getStatus(session.id, terminalConfig.id).state,
      "running",
    );
    assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1000);
  }

  assert.equal(factory.terminals[0].kills, 3);
  factory.terminals[0].emitExit(0);
}

async function testWindowsInputFallback(
  SessionManager,
  WindowsConsoleInputError,
) {
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  for (const testCase of [
    {
      delivery: "not-delivered",
      currentWrites: ["current input"],
    },
    {
      delivery: "unknown",
      currentWrites: [],
    },
  ]) {
    const factory = createPtyFactory();
    const helperWrites = [];
    const windowsConsoleInput = {
      async start() {},
      async write(processId, data) {
        helperWrites.push({ processId, data });
        throw new WindowsConsoleInputError(
          "injected failure",
          "helper",
          testCase.delivery,
        );
      },
      dispose() {},
    };
    const manager = new SessionManager(process.cwd(), {
      ptySpawn: factory.spawn,
      windowsConsoleInput,
    });
    await manager.start(session, terminalConfig);

    await manager.write(session.id, terminalConfig.id, "current input");
    assert.deepEqual(factory.terminals[0].writes, testCase.currentWrites);
    assert.deepEqual(helperWrites, [
      { processId: 1000, data: "current input" },
    ]);

    await manager.write(session.id, terminalConfig.id, "subsequent input");
    assert.deepEqual(factory.terminals[0].writes, [
      ...testCase.currentWrites,
      "subsequent input",
    ]);
    assert.equal(helperWrites.length, 1);
    factory.terminals[0].emitExit(0);
  }
}

async function main() {
  const { SessionManager } = await import("../dist/sessionManager.js");
  const { WindowsConsoleInputError } =
    await import("../dist/windowsConsoleInput.js");

  await testStaleRuntimeCallbacks(SessionManager);
  await testStopTimeoutAndDeletion(SessionManager);
  await testWindowsInputFallback(SessionManager, WindowsConsoleInputError);

  console.log("session manager tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
