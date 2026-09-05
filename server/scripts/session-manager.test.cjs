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
  constructor(pid, file, args, options) {
    this.pid = pid;
    this.file = file;
    this.args = Array.isArray(args) ? [...args] : args;
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
    spawn(file, args, options) {
      const terminal = new FakePty(
        1000 + terminals.length,
        file,
        args,
        options,
      );
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

async function testEmptyCommandStartsInteractiveShell(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = { ...session.terminals[0], command: "" };

  await manager.start(session, terminalConfig);

  assert.equal(
    factory.terminals[0].file,
    process.platform === "win32"
      ? process.env.TERMRAIL_SHELL || "powershell.exe"
      : process.env.SHELL || "/bin/sh",
  );
  assert.deepEqual(factory.terminals[0].args, []);

  factory.terminals[0].emitExit(0);
}

async function testEmptyCommandInputUsesPty(SessionManager) {
  const factory = createPtyFactory();
  const windowsConsoleInput = createBlockingWindowsConsoleInput();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
    windowsConsoleInput,
  });
  const session = sessionConfig();
  const terminalConfig = { ...session.terminals[0], command: "" };

  await manager.start(session, terminalConfig);
  await manager.write(session.id, terminalConfig.id, "interactive input");

  assert.deepEqual(windowsConsoleInput.writes, []);
  assert.deepEqual(factory.terminals[0].writes, ["interactive input"]);

  factory.terminals[0].emitExit(0);
}

async function testNonEmptyCommandUsesShellCommandMode(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = { ...session.terminals[0], command: " test-command " };

  await manager.start(session, terminalConfig);

  assert.deepEqual(
    factory.terminals[0].args,
    process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "test-command",
        ]
      : ["-lc", "test-command"],
  );

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
  assert.deepEqual(await manager.getSnapshot(session.id, terminalConfig.id), {
    status: manager.getStatus(session.id, terminalConfig.id),
    runtimeId: 1,
    format: "xterm-serialized-vt",
    mode: "tail",
    data: "first",
    seq: 1,
    minSeq: 1,
    complete: true,
    cols: 120,
    rows: 36,
    screenRevision: 1,
    bufferType: "normal",
  });
  factory.terminals[0].emitExit(0);

  await manager.start(session, terminalConfig);
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  factory.terminals[1].emitData("second");
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "second");
  assert.equal(
    (await manager.getSnapshot(session.id, terminalConfig.id)).seq,
    1,
  );
  factory.terminals[1].emitExit(0);

  await manager.deleteTerminalRuntime(session.id, terminalConfig.id);
  await manager.start(session, terminalConfig);
  assert.equal(manager.getBuffer(session.id, terminalConfig.id), "");
  factory.terminals[2].emitData("third");
  assert.equal(
    (await manager.getSnapshot(session.id, terminalConfig.id)).seq,
    1,
  );

  assert.deepEqual(
    output.map((event) => ({
      data: event.data,
      runtimeId: event.runtimeId,
      seq: event.seq,
    })),
    [
      { data: "first", runtimeId: 1, seq: 1 },
      { data: "second", runtimeId: 2, seq: 1 },
      { data: "third", runtimeId: 3, seq: 1 },
    ],
  );

  factory.terminals[2].emitExit(0);
}

async function testSnapshotDoesNotResizePty(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  await manager.start(session, terminalConfig);
  const snapshot = await manager.getSnapshot(session.id, terminalConfig.id, {
    requestedSize: {
      cols: 88,
      rows: 24,
    },
  });

  assert.deepEqual(factory.terminals[0].resizes, []);
  assert.equal(snapshot.cols, 120);
  assert.equal(snapshot.rows, 36);

  factory.terminals[0].emitExit(0);
}

async function testTerminalEnvironmentSupportsColor(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  await manager.start(session, terminalConfig);
  const env = factory.terminals[0].options.env;
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.TERM_PROGRAM, "TermRail");
  assert.equal(env.NO_COLOR, undefined);
  assert.notEqual(env, process.env);

  factory.terminals[0].emitExit(0);
}

async function testStoppedSnapshotIsComplete(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  const uninitializedSnapshot = await manager.getSnapshot(
    session.id,
    terminalConfig.id,
    {
      requestedSize: { cols: 90, rows: 25 },
      minSeq: 42,
    },
  );
  assert.equal(uninitializedSnapshot.runtimeId, null);
  assert.equal(uninitializedSnapshot.seq, 0);
  assert.equal(uninitializedSnapshot.minSeq, null);
  assert.equal(uninitializedSnapshot.complete, true);
  assert.equal(uninitializedSnapshot.cols, 90);
  assert.equal(uninitializedSnapshot.rows, 25);

  manager.resize(session.id, terminalConfig.id, 88, 24);
  const resizedStoppedSnapshot = await manager.getSnapshot(
    session.id,
    terminalConfig.id,
    { minSeq: 42 },
  );
  assert.equal(resizedStoppedSnapshot.runtimeId, null);
  assert.equal(resizedStoppedSnapshot.seq, 0);
  assert.equal(resizedStoppedSnapshot.minSeq, null);
  assert.equal(resizedStoppedSnapshot.complete, true);
  assert.equal(resizedStoppedSnapshot.cols, 88);
  assert.equal(resizedStoppedSnapshot.rows, 24);
  assert.deepEqual(factory.terminals, []);
}

async function testResizeUpdatesSnapshotSize(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];

  await manager.start(session, terminalConfig);
  manager.resize(session.id, terminalConfig.id, 88, 24);
  const snapshot = await manager.getSnapshot(session.id, terminalConfig.id);

  assert.deepEqual(factory.terminals[0].resizes, [{ cols: 88, rows: 24 }]);
  assert.equal(snapshot.cols, 88);
  assert.equal(snapshot.rows, 24);

  factory.terminals[0].emitExit(0);
}

async function testSnapshotModes(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const lines = Array.from(
    { length: 80 },
    (_, index) => `line-${String(index).padStart(3, "0")}`,
  );

  await manager.start(session, terminalConfig, { cols: 80, rows: 10 });
  factory.terminals[0].emitData(`${lines.join("\r\n")}\r\n`);

  const tailSnapshot = await manager.getSnapshot(
    session.id,
    terminalConfig.id,
    {
      mode: "tail",
      minSeq: 1,
    },
  );
  assert.equal(tailSnapshot.mode, "tail");
  assert.equal(tailSnapshot.minSeq, 1);
  assert.equal(tailSnapshot.complete, true);
  assert.ok(tailSnapshot.data.includes("line-079"));
  assert.equal(tailSnapshot.data.includes("line-000"), false);

  const fullSnapshot = await manager.getSnapshot(
    session.id,
    terminalConfig.id,
    {
      mode: "full",
      minSeq: 1,
    },
  );
  assert.equal(fullSnapshot.mode, "full");
  assert.equal(fullSnapshot.minSeq, 1);
  assert.equal(fullSnapshot.complete, true);
  assert.ok(fullSnapshot.data.includes("line-079"));
  assert.ok(fullSnapshot.data.includes("line-000"));

  factory.terminals[0].emitExit(0);
}

async function testTinyOutputChunksSnapshotQuickly(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const chunkCount = 3000;

  await manager.start(session, terminalConfig);
  for (let index = 0; index < chunkCount; index += 1) {
    factory.terminals[0].emitData(`line-${index}\r\n`);
  }

  const startedAt = Date.now();
  const snapshot = await manager.getSnapshot(session.id, terminalConfig.id);

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(snapshot.seq, chunkCount);
  assert.equal(snapshot.mode, "tail");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.data.includes(`line-${chunkCount - 1}`));

  factory.terminals[0].emitExit(0);
}

async function testSnapshotCompletesWhileOutputContinues(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  let emitted = 0;

  await manager.start(session, terminalConfig, { cols: 60, rows: 12 });
  const emitBatch = () => {
    for (let index = 0; index < 64; index += 1) {
      emitted += 1;
      factory.terminals[0].emitData(`stream-${emitted}\r\n`);
    }
  };
  emitBatch();
  const minSeq = emitted;
  const outputTimer = setInterval(emitBatch, 1);

  let snapshot;
  try {
    snapshot = await manager.getSnapshot(session.id, terminalConfig.id, {
      mode: "full",
      minSeq,
    });
  } finally {
    clearInterval(outputTimer);
  }

  assert.ok(emitted > minSeq);
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.seq >= minSeq);
  assert.ok(snapshot.data.includes("stream-"));

  factory.terminals[0].emitExit(0);
}

async function testScreenProgressTracksRenderedWork(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const progress = [];
  manager.on("screenProgress", (event) => progress.push(event));

  await manager.start(session, terminalConfig, { cols: 40, rows: 4 });
  factory.terminals[0].emitData(
    Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\r\n"),
  );
  await waitFor(() => progress.length === 1, "normal screen progress");

  assert.equal(progress[0].runtimeId, 1);
  assert.equal(progress[0].seq, 1);
  assert.equal(progress[0].bufferType, "normal");
  assert.equal(progress[0].rows, 4);
  assert.ok(progress[0].screenRevision >= 4);

  const revisionBeforeResize = progress[0].screenRevision;
  manager.resize(session.id, terminalConfig.id, 50, 6);
  const resizedSnapshot = await manager.getSnapshot(
    session.id,
    terminalConfig.id,
  );
  assert.equal(resizedSnapshot.screenRevision, revisionBeforeResize);
  assert.equal(resizedSnapshot.cols, 50);
  assert.equal(resizedSnapshot.rows, 6);

  factory.terminals[0].emitExit(0);
}

async function testAlternateBufferScreenProgress(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const progress = [];
  manager.on("screenProgress", (event) => progress.push(event));

  await manager.start(session, terminalConfig, { cols: 40, rows: 6 });
  factory.terminals[0].emitData("\x1b[?1049h\x1b[2J\x1b[HSelect a session");
  await waitFor(() => progress.length === 1, "alternate screen progress");

  assert.equal(progress[0].bufferType, "alternate");
  assert.ok(progress[0].screenRevision > 0);
  const snapshot = await manager.getSnapshot(session.id, terminalConfig.id);
  assert.equal(snapshot.bufferType, "alternate");
  assert.equal(snapshot.screenRevision, progress[0].screenRevision);

  factory.terminals[0].emitExit(0);
}

async function testScreenProgressResetsWithRuntime(SessionManager) {
  const factory = createPtyFactory();
  const manager = new SessionManager(process.cwd(), {
    ptySpawn: factory.spawn,
  });
  const session = sessionConfig();
  const terminalConfig = session.terminals[0];
  const progress = [];
  manager.on("screenProgress", (event) => progress.push(event));

  await manager.start(session, terminalConfig, { cols: 40, rows: 4 });
  factory.terminals[0].emitData(
    Array.from({ length: 20 }, (_, index) => `old-${index}`).join("\r\n"),
  );
  await waitFor(() => progress.length === 1, "first runtime progress");
  const firstRevision = progress[0].screenRevision;
  factory.terminals[0].emitExit(0);

  await manager.start(session, terminalConfig, { cols: 40, rows: 4 });
  factory.terminals[1].emitData("new");
  await waitFor(() => progress.length === 2, "second runtime progress");

  assert.equal(progress[1].runtimeId, 2);
  assert.equal(progress[1].seq, 1);
  assert.ok(progress[1].screenRevision < firstRevision);

  factory.terminals[1].emitExit(0);
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
  await testEmptyCommandStartsInteractiveShell(SessionManager);
  await testEmptyCommandInputUsesPty(SessionManager);
  await testNonEmptyCommandUsesShellCommandMode(SessionManager);
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
  await testSnapshotDoesNotResizePty(SessionManager);
  await testTerminalEnvironmentSupportsColor(SessionManager);
  await testStoppedSnapshotIsComplete(SessionManager);
  await testResizeUpdatesSnapshotSize(SessionManager);
  await testSnapshotModes(SessionManager);
  await testTinyOutputChunksSnapshotQuickly(SessionManager);
  await testSnapshotCompletesWhileOutputContinues(SessionManager);
  await testScreenProgressTracksRenderedWork(SessionManager);
  await testAlternateBufferScreenProgress(SessionManager);
  await testScreenProgressResetsWithRuntime(SessionManager);
  await testWindowsInputFallback(SessionManager, WindowsConsoleInputError);
  await testUnsupportedWindowsInputUsesPty(SessionManager);

  console.log("session manager tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
