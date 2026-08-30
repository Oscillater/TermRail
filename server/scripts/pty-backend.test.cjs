const assert = require("node:assert/strict");

async function main() {
  const { resolvePtyBackend } = await import("../dist/ptyBackend.js");

  assert.deepEqual(resolvePtyBackend("win32"), {
    backend: "conpty",
    useConpty: true,
    useWindowsConsoleInput: true,
  });
  assert.deepEqual(resolvePtyBackend("win32", ""), {
    backend: "conpty",
    useConpty: true,
    useWindowsConsoleInput: true,
  });
  assert.deepEqual(resolvePtyBackend("win32", "  WINPTY  "), {
    backend: "winpty",
    useConpty: false,
    useWindowsConsoleInput: false,
  });
  assert.deepEqual(resolvePtyBackend("win32", "ConPTY"), {
    backend: "conpty",
    useConpty: true,
    useWindowsConsoleInput: true,
  });
  assert.throws(
    () => resolvePtyBackend("win32", "automatic"),
    /TERMRAIL_WINDOWS_PTY must be either "winpty" or "conpty"/,
  );
  assert.deepEqual(resolvePtyBackend("linux", "invalid-on-windows"), {
    backend: "platform-default",
    useWindowsConsoleInput: false,
  });

  console.log("pty backend tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
