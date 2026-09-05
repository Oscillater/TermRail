const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { ConfigStore } = await import("../dist/configStore.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "termrail-config-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          prompts: [],
          sessions: [
            {
              id: "legacy-tabs",
              name: "Legacy Tabs",
              cwd: ".",
              command: "new-session-command",
              terminals: [
                { id: "custom", name: "Custom", command: "old-terminal" },
              ],
              prompts: [],
            },
            {
              id: "legacy-command-only",
              name: "Legacy Command Only",
              cwd: ".",
              command: "legacy-command",
              prompts: [],
            },
            {
              id: "legacy-empty-terminals",
              name: "Legacy Empty Terminals",
              cwd: ".",
              command: "legacy-empty-command",
              terminals: [],
              prompts: [],
            },
            {
              id: "empty-session",
              name: "Empty Session",
              cwd: ".",
              terminals: [],
              prompts: [],
            },
            {
              id: "interactive-terminal",
              name: "Interactive Terminal",
              cwd: ".",
              terminals: [{ id: "shell", name: "Shell", command: "" }],
              prompts: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store = new ConfigStore(configPath);
    await store.load();

    const sessions = store.listSessions();
    assert.equal(Object.hasOwn(sessions[0], "command"), false);
    assert.deepEqual(sessions[0].terminals, [
      { id: "custom", name: "Custom", command: "old-terminal" },
    ]);
    assert.deepEqual(sessions[1].terminals, [
      { id: "main", name: "Main", command: "legacy-command" },
    ]);
    assert.deepEqual(sessions[2].terminals, [
      { id: "main", name: "Main", command: "legacy-empty-command" },
    ]);
    assert.deepEqual(sessions[3].terminals, []);
    assert.deepEqual(sessions[4].terminals, [
      { id: "shell", name: "Shell", command: "" },
    ]);

    const created = await store.createSession({
      id: "new-empty",
      name: "New Empty",
      cwd: ".",
      prompts: [],
    });
    assert.deepEqual(created.terminals, []);

    const interactiveTerminal = await store.createTerminal("empty-session", {
      name: "Interactive",
      command: "",
    });
    assert.equal(interactiveTerminal.command, "");
    await assert.rejects(
      store.createTerminal("empty-session", {
        name: "",
        command: "",
      }),
      (error) => error?.code === "INVALID_TERMINAL",
    );

    await assert.rejects(
      store.createSession({
        id: "invalid-command",
        name: "Invalid Command",
        cwd: ".",
        command: "node -v",
        prompts: [],
      }),
      (error) => error?.code === "INVALID_SESSION",
    );
    await assert.rejects(
      store.createSession({
        id: "invalid-terminals",
        name: "Invalid Terminals",
        cwd: ".",
        terminals: [],
        prompts: [],
      }),
      (error) => error?.code === "TERMINALS_READ_ONLY",
    );
    await assert.rejects(
      store.updateSession("empty-session", { command: "node -v" }),
      (error) => error?.code === "INVALID_SESSION",
    );
    await assert.rejects(
      store.updateSession("empty-session", { terminals: [] }),
      (error) => error?.code === "TERMINALS_READ_ONLY",
    );

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(
      saved.sessions.some((session) => Object.hasOwn(session, "command")),
      false,
    );
    console.log("config model ok");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
