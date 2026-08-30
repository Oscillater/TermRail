const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

class FakeHelperProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.requestBuffer = "";
    this.requests = [];
    this.requestWaiters = [];

    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.requestBuffer += chunk;
      let newlineIndex = this.requestBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.requestBuffer.slice(0, newlineIndex);
        this.requestBuffer = this.requestBuffer.slice(newlineIndex + 1);
        const fields = line.split("\t");
        const request = {
          id: Number(fields[0]),
          processId: Number(fields[1]),
          data: Buffer.from(fields[2], "base64").toString("utf8"),
        };
        const waiter = this.requestWaiters.shift();
        if (waiter) {
          waiter(request);
        } else {
          this.requests.push(request);
        }
        newlineIndex = this.requestBuffer.indexOf("\n");
      }
    });
  }

  kill() {
    this.exitCode = 1;
    return true;
  }

  nextRequest() {
    const request = this.requests.shift();
    if (request) {
      return Promise.resolve(request);
    }
    return new Promise((resolve) => this.requestWaiters.push(resolve));
  }

  respond(kind, requestId, message) {
    const encodedMessage = message
      ? `\t${Buffer.from(message, "utf8").toString("base64")}`
      : "";
    this.stdout.write(`${kind}\t${requestId}${encodedMessage}\n`);
  }

  exitAfterDispatch() {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}

async function rejectionOf(promise) {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error) => error,
  );
}

async function startInput(WindowsConsoleInput, timeouts = {}) {
  let child;
  const input = new WindowsConsoleInput(() => {
    child = new FakeHelperProcess();
    return child;
  }, timeouts);
  const start = input.start();
  child.stdout.write("READY\n");
  await start;
  return { child, input };
}

async function main() {
  const {
    isWindowsConsoleInputRetrySafe,
    shouldUseWindowsConsoleInput,
    WindowsConsoleInput,
    WindowsConsoleInputError,
  } = await import("../dist/windowsConsoleInput.js");

  assert.equal(shouldUseWindowsConsoleInput("text\u201d\u4e2d\u6587\r"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x7f"), true);
  assert.equal(shouldUseWindowsConsoleInput("\n"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1b"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[B"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[1;5C"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[3~"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1bOP"), true);
  assert.equal(shouldUseWindowsConsoleInput("\x1bx"), true);
  assert.equal(
    shouldUseWindowsConsoleInput("\x1b[200~mixed\u201dtext\x1b[201~"),
    true,
  );

  assert.equal(shouldUseWindowsConsoleInput("\x1b[I"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[O"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[12;40R"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[<0;12;8M"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x1b[27~"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x03"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x16"), false);
  assert.equal(shouldUseWindowsConsoleInput("\x1b\x7f"), false);

  let spawnCount = 0;
  let failedChild;
  const failedInput = new WindowsConsoleInput(() => {
    spawnCount += 1;
    failedChild = new FakeHelperProcess();
    return failedChild;
  });
  const firstStart = failedInput.start();
  process.nextTick(() => failedChild.emit("error", new Error("helper failed")));
  const firstStartError = await rejectionOf(firstStart);
  assert.equal(isWindowsConsoleInputRetrySafe(firstStartError), true);
  const secondStartError = await rejectionOf(failedInput.start());
  assert.equal(isWindowsConsoleInputRetrySafe(secondStartError), true);
  assert.equal(spawnCount, 1);
  failedInput.dispose();

  const acknowledged = await startInput(WindowsConsoleInput);
  const acknowledgedWrite = acknowledged.input.write(42, "hello");
  const acknowledgedRequest = await acknowledged.child.nextRequest();
  assert.deepEqual(acknowledgedRequest, {
    id: 1,
    processId: 42,
    data: "hello",
  });
  acknowledged.child.respond("ACK", acknowledgedRequest.id);
  await acknowledgedWrite;
  acknowledged.input.dispose();

  const safeFailure = await startInput(WindowsConsoleInput);
  const safeWrite = safeFailure.input.write(43, "retry me");
  const safeRequest = await safeFailure.child.nextRequest();
  safeFailure.child.respond("ERR_SAFE", safeRequest.id, "AttachConsole failed");
  const safeError = await rejectionOf(safeWrite);
  assert.ok(safeError instanceof WindowsConsoleInputError);
  assert.equal(safeError.scope, "target");
  assert.equal(safeError.delivery, "not-delivered");
  assert.equal(isWindowsConsoleInputRetrySafe(safeError), true);
  safeFailure.input.dispose();

  const unknownFailure = await startInput(WindowsConsoleInput);
  const unknownWrite = unknownFailure.input.write(44, "do not retry");
  const unknownRequest = await unknownFailure.child.nextRequest();
  unknownFailure.child.respond(
    "ERR_UNKNOWN",
    unknownRequest.id,
    "WriteConsoleInputW may have written records",
  );
  const unknownError = await rejectionOf(unknownWrite);
  assert.ok(unknownError instanceof WindowsConsoleInputError);
  assert.equal(unknownError.scope, "target");
  assert.equal(unknownError.delivery, "unknown");
  assert.equal(isWindowsConsoleInputRetrySafe(unknownError), false);
  unknownFailure.input.dispose();

  const timedOut = await startInput(WindowsConsoleInput, {
    requestTimeoutMs: 20,
  });
  const timedOutWrite = timedOut.input.write(45, "ack lost");
  await timedOut.child.nextRequest();
  const timeoutError = await rejectionOf(timedOutWrite);
  assert.equal(timeoutError.delivery, "unknown");
  assert.equal(isWindowsConsoleInputRetrySafe(timeoutError), false);
  const afterTimeoutError = await rejectionOf(
    timedOut.input.write(45, "not dispatched"),
  );
  assert.equal(afterTimeoutError.delivery, "not-delivered");
  assert.equal(isWindowsConsoleInputRetrySafe(afterTimeoutError), true);
  timedOut.input.dispose();

  const exited = await startInput(WindowsConsoleInput);
  const exitedWrite = exited.input.write(46, "helper exits");
  await exited.child.nextRequest();
  exited.child.exitAfterDispatch();
  const exitError = await rejectionOf(exitedWrite);
  assert.equal(exitError.delivery, "unknown");
  assert.equal(isWindowsConsoleInputRetrySafe(exitError), false);
  const afterExitError = await rejectionOf(
    exited.input.write(46, "not dispatched either"),
  );
  assert.equal(afterExitError.delivery, "not-delivered");
  assert.equal(isWindowsConsoleInputRetrySafe(afterExitError), true);
  exited.input.dispose();

  const invalidResponse = await startInput(WindowsConsoleInput);
  const invalidWrite = invalidResponse.input.write(47, "bad protocol");
  const invalidRequest = await invalidResponse.child.nextRequest();
  invalidResponse.child.respond("ERR", invalidRequest.id, "old protocol");
  const invalidError = await rejectionOf(invalidWrite);
  assert.equal(invalidError.delivery, "unknown");
  assert.equal(isWindowsConsoleInputRetrySafe(invalidError), false);
  invalidResponse.input.dispose();

  console.log("Windows console input routing tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
