const assert = require("node:assert/strict");

async function main() {
  const { SessionOperationQueue } =
    await import("../dist/sessionOperationQueue.js");
  const queue = new SessionOperationQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run("session-a", async () => {
    order.push("a:first:start");
    await firstGate;
    order.push("a:first:end");
  });
  const second = queue.run("session-a", async () => {
    order.push("a:second");
  });
  const otherSession = queue.run("session-b", async () => {
    order.push("b:first");
  });

  await otherSession;
  assert.deepEqual(order, ["a:first:start", "b:first"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "a:first:start",
    "b:first",
    "a:first:end",
    "a:second",
  ]);

  await assert.rejects(
    queue.run("session-a", async () => {
      throw new Error("expected failure");
    }),
    /expected failure/,
  );
  await queue.run("session-a", async () => {
    order.push("a:after-failure");
  });
  assert.equal(order.at(-1), "a:after-failure");

  console.log("session operation queue tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
