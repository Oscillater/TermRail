const assert = require("node:assert/strict");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakePty {
  constructor(pid, options) {
    this.pid = pid;
    this.options = options;
    this.dataListeners = [];
    this.exitListeners = [];
    this.kills = 0;
    this.writes = [];
    this.resizes = [];
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

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

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
    spawn(_file, _args, options) {
      const terminal = new FakePty(1000 + terminals.length, options);
      terminals.push(terminal);
      return terminal;
    },
  };
}

function createBlockingWindowsConsoleInput() {
  const writes = [];
  const waiters = [];
  let nextReadIndex = 0;

  return {
    writes,
    async start() {},
    write(processId, data) {
      const pending = deferred();
      const write = { processId, data, pending };
      writes.push(write);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(write);
      }
      return pending.promise;
    },
    nextWrite() {
      if (nextReadIndex < writes.length) {
        const write = writes[nextReadIndex];
        nextReadIndex += 1;
        return Promise.resolve(write);
      }
      return new Promise((resolve) => {
        waiters.push((write) => {
          nextReadIndex += 1;
          resolve(write);
        });
      });
    },
    dispose() {},
  };
}

function createSequencedWindowsConsoleInput(
  WindowsConsoleInputError,
  deliveries,
) {
  const writes = [];
  const outcomes = [...deliveries];

  return {
    writes,
    async start() {},
    async write(processId, data) {
      writes.push({ processId, data });
      const outcome = outcomes.shift() ?? "delivered";
      if (outcome === "delivered") {
        return;
      }
      throw new WindowsConsoleInputError("injected failure", "helper", outcome);
    },
    dispose() {},
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

async function waitFor(predicate, description, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
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

async function testResizeDuringStartUsesLatestSize(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  const start = manager.start(session, terminalConfig);
  manager.resize(session.id, terminalConfig.id, 88, 24);
  await start;

  assert.equal(factory.terminals[0].options.cols, 88);
  assert.equal(factory.terminals[0].options.rows, 24);
  factory.terminals[0].emitExit(0);
}

async function testExplicitStartSizeOverridesConcurrentResize(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  const start = manager.start(session, terminalConfig, { cols: 100, rows: 40 });
  manager.resize(session.id, terminalConfig.id, 88, 24);
  await start;

  assert.equal(factory.terminals[0].options.cols, 100);
  assert.equal(factory.terminals[0].options.rows, 40);
  factory.terminals[0].emitExit(0);
}

async function testResizeAfterDeleteRecreateTargetsCurrentRuntime(
  SessionManager,
) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  await manager.start(session, terminalConfig);
  const oldTerminal = factory.terminals[0];
  manager.resize(session.id, terminalConfig.id, 88, 24);
  oldTerminal.emitExit(0);
  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);

  await manager.start(session, terminalConfig);
  const newTerminal = factory.terminals[1];
  manager.resize(session.id, terminalConfig.id, 132, 43);
  oldTerminal.emitData("stale output");
  oldTerminal.emitExit(99);
  newTerminal.emitData("current output");

  assert.deepEqual(oldTerminal.resizes, [{ cols: 88, rows: 24 }]);
  assert.deepEqual(newTerminal.resizes, [{ cols: 132, rows: 43 }]);
  assert.equal(
    manager.getBuffer(session.id, terminalConfig.id),
    "current output",
  );
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);

  newTerminal.emitExit(0);
}

async function testConcurrentStartRejectsDuplicate(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  const start = manager.start(session, terminalConfig);
  const duplicateStartError = await rejectionOf(
    manager.start(session, terminalConfig),
  );
  const status = await start;

  assert.equal(status.state, "running");
  assert.equal(duplicateStartError.statusCode, 409);
  assert.equal(duplicateStartError.code, "TERMINAL_RUNNING");
  assert.equal(factory.terminals.length, 1);

  factory.terminals[0].emitExit(0);
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
  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "stopped",
  );

  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  const newTerminal = factory.terminals[1];
  newTerminal.emitData("new after timeout");
  factory.terminals[0].emitData("stale after timeout");
  factory.terminals[0].emitExit(99);

  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "running",
  );
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);
  assert.equal(
    manager.getBuffer(session.id, terminalConfig.id),
    "new after timeout",
  );

  newTerminal.emitExit(0);
}

async function testConcurrentStopSharesInFlightStop(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  const firstStop = manager.stop(session.id, terminalConfig.id);
  const secondStop = manager.stop(session.id, terminalConfig.id);

  assert.equal(factory.terminals[0].kills, 1);
  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "running",
  );

  factory.terminals[0].emitExit(0);
  const statuses = await Promise.all([firstStop, secondStop]);

  assert.deepEqual(
    statuses.map((status) => status.state),
    ["stopped", "stopped"],
  );
  assert.equal(factory.terminals[0].kills, 1);
}

async function testStartWhileStoppingIsRejected(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  const stop = manager.stop(session.id, terminalConfig.id);
  const startError = await rejectionOf(manager.start(session, terminalConfig));

  assert.equal(startError.statusCode, 409);
  assert.equal(startError.code, "TERMINAL_RUNNING");
  assert.equal(factory.terminals[0].kills, 1);

  factory.terminals[0].emitExit(0);
  await stop;

  await manager.start(session, terminalConfig);
  assert.equal(factory.terminals.length, 2);
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);

  factory.terminals[1].emitExit(0);
}

async function testDeleteWhileStoppingSharesStopAndRemovesRuntime(
  SessionManager,
) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  const stop = manager.stop(session.id, terminalConfig.id);
  const deletion = manager.deleteTerminalRuntime(session.id, terminalConfig.id);

  assert.equal(factory.terminals[0].kills, 1);

  factory.terminals[0].emitExit(0);
  await Promise.all([stop, deletion]);

  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "stopped",
  );

  await manager.start(session, terminalConfig);
  assert.equal(factory.terminals.length, 2);
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);

  factory.terminals[1].emitExit(0);
}

async function testDeleteWhileStartingStopsAndRemovesRuntime(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  const start = manager.start(session, terminalConfig);
  const deletion = manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await start;

  await waitFor(
    () => factory.terminals[0]?.kills === 1,
    "delete while starting to stop the new PTY",
  );
  factory.terminals[0].emitExit(0);
  await deletion;

  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  assert.equal(
    manager.getStatus(session.id, terminalConfig.id).state,
    "stopped",
  );

  await manager.start(session, terminalConfig);
  assert.equal(factory.terminals.length, 2);
  assert.equal(manager.getStatus(session.id, terminalConfig.id).pid, 1001);

  factory.terminals[1].emitExit(0);
}

async function testQueuedInputIsBoundToOriginalRuntime(SessionManager) {
  const factory = createPtyFactory();
  const windowsConsoleInput = createBlockingWindowsConsoleInput();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    windowsConsoleInput,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  const firstWrite = manager.write(
    session.id,
    terminalConfig.id,
    "first input",
  );
  const firstHelperWrite = await windowsConsoleInput.nextWrite();
  assert.deepEqual(
    {
      processId: firstHelperWrite.processId,
      data: firstHelperWrite.data,
    },
    { processId: 1000, data: "first input" },
  );

  const secondWrite = manager.write(
    session.id,
    terminalConfig.id,
    "second input",
  );
  const oldTerminal = factory.terminals[0];
  oldTerminal.emitExit(0);
  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  const newTerminal = factory.terminals[1];

  firstHelperWrite.pending.resolve();
  await Promise.all([firstWrite, secondWrite]);

  assert.equal(windowsConsoleInput.writes.length, 1);
  assert.deepEqual(oldTerminal.writes, []);
  assert.deepEqual(newTerminal.writes, []);

  newTerminal.emitExit(0);
}

async function testStaleHelperFailureDoesNotFallback(
  SessionManager,
  WindowsConsoleInputError,
) {
  const factory = createPtyFactory();
  const windowsConsoleInput = createBlockingWindowsConsoleInput();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    windowsConsoleInput,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  const write = manager.write(session.id, terminalConfig.id, "stale input");
  const helperWrite = await windowsConsoleInput.nextWrite();
  const oldTerminal = factory.terminals[0];
  oldTerminal.emitExit(0);
  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  const newTerminal = factory.terminals[1];

  helperWrite.pending.reject(
    new WindowsConsoleInputError("injected failure", "helper", "not-delivered"),
  );
  await write;

  assert.deepEqual(oldTerminal.writes, []);
  assert.deepEqual(newTerminal.writes, []);

  newTerminal.emitExit(0);
}

async function testOutputSeqAndBufferSemantics(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const output = [];
  manager.on("output", (event) => output.push(event));

  await manager.start(session, terminalConfig);
  factory.terminals[0].emitData("first");
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "first");
  factory.terminals[0].emitExit(0);

  await manager.start(session, terminalConfig);
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  factory.terminals[1].emitData("second");
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "second");
  factory.terminals[1].emitExit(0);

  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  factory.terminals[2].emitData("third");

  assert.deepEqual(
    output.map((event) => ({
      data: event.data,
      seq: event.seq,
    })),
    [
      { data: "first", seq: 1 },
      { data: "second", seq: 2 },
      { data: "third", seq: 1 },
    ],
  );

  factory.terminals[2].emitExit(0);
}

async function testWindowsInputFallback(
  SessionManager,
  WindowsConsoleInputError,
) {
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  for (const testCase of [
    {
      deliveries: ["not-delivered", "delivered"],
      currentWritesAfterFirst: ["current input"],
      currentWritesAfterSecond: ["current input"],
    },
    {
      deliveries: ["unknown", "delivered"],
      currentWritesAfterFirst: [],
      currentWritesAfterSecond: [],
    },
    {
      deliveries: ["unknown", "not-delivered"],
      currentWritesAfterFirst: [],
      currentWritesAfterSecond: ["subsequent input"],
    },
  ]) {
    const factory = createPtyFactory();
    const windowsConsoleInput = createSequencedWindowsConsoleInput(
      WindowsConsoleInputError,
      testCase.deliveries,
    );
    const manager = new SessionManager(process.cwd(), {
      ptySpawn: factory.spawn,
      windowsConsoleInput,
    });
    await manager.start(session, terminalConfig);

    await manager.write(session.id, terminalConfig.id, "current input");
    assert.deepEqual(
      factory.terminals[0].writes,
      testCase.currentWritesAfterFirst,
    );
    assert.deepEqual(windowsConsoleInput.writes, [
      { processId: 1000, data: "current input" },
    ]);

    await manager.write(session.id, terminalConfig.id, "subsequent input");
    assert.deepEqual(
      factory.terminals[0].writes,
      testCase.currentWritesAfterSecond,
    );
    assert.deepEqual(windowsConsoleInput.writes, [
      { processId: 1000, data: "current input" },
      { processId: 1000, data: "subsequent input" },
    ]);
    factory.terminals[0].emitExit(0);
  }
}

async function testUnsupportedWindowsInputUsesPty(SessionManager) {
  const factory = createPtyFactory();
  const windowsConsoleInput = {
    writes: [],
    async start() {},
    async write(processId, data) {
      this.writes.push({ processId, data });
      throw new Error("helper should not be used for unsupported input");
    },
    dispose() {},
  };
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    windowsConsoleInput,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  await manager.start(session, terminalConfig);

  await manager.write(session.id, terminalConfig.id, "\x03");

  assert.deepEqual(windowsConsoleInput.writes, []);
  assert.deepEqual(factory.terminals[0].writes, ["\x03"]);
  factory.terminals[0].emitExit(0);
}

async function main() {
  const { SessionManager } = await import("../dist/sessionManager.js");
  const { WindowsConsoleInputError } =
    await import("../dist/windowsConsoleInput.js");

  await testStaleRuntimeCallbacks(SessionManager);
  await testResizeDuringStartUsesLatestSize(SessionManager);
  await testExplicitStartSizeOverridesConcurrentResize(SessionManager);
  await testResizeAfterDeleteRecreateTargetsCurrentRuntime(SessionManager);
  await testConcurrentStartRejectsDuplicate(SessionManager);
  await testStopTimeoutAndDeletion(SessionManager);
  await testConcurrentStopSharesInFlightStop(SessionManager);
  await testStartWhileStoppingIsRejected(SessionManager);
  await testDeleteWhileStoppingSharesStopAndRemovesRuntime(SessionManager);
  await testDeleteWhileStartingStopsAndRemovesRuntime(SessionManager);
  await testQueuedInputIsBoundToOriginalRuntime(SessionManager);
  await testStaleHelperFailureDoesNotFallback(
    SessionManager,
    WindowsConsoleInputError,
  );
  await testOutputSeqAndBufferSemantics(SessionManager);
  await testWindowsInputFallback(SessionManager, WindowsConsoleInputError);
  await testUnsupportedWindowsInputUsesPty(SessionManager);

  console.log("session manager tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
