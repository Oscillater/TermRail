// Packages TermRail as a portable Windows bundle: a pinned node.exe plus the
// built server/web assets and production node_modules. The staging layout
// mirrors the repository (server/dist, web/dist, node_modules at the root) so
// the server's projectRoot-relative paths (data/, web/dist) work unchanged.
//
// Usage: npm run package  (builds all workspaces first, then runs this script)

import { createHash } from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

// LTS "Krypton". Bumping this is a deliberate act: it ships to end users.
const NODE_VERSION = "24.21.0";
// Override with a mirror when nodejs.org is unreliable from your network,
// e.g. TERMRAIL_NODE_DIST_BASE=https://npmmirror.com/mirrors/node
const NODE_DIST_BASE =
  process.env.TERMRAIL_NODE_DIST_BASE || "https://nodejs.org/dist";

const PACKAGE_ROOT = resolvePackageRoot();
const RELEASE_DIR = join(PACKAGE_ROOT, "release");
const STAGING_DIR = join(RELEASE_DIR, "termrail");
const CACHE_DIR = join(RELEASE_DIR, "cache");

// Direct production dependencies of @termrail/server. Exact versions are read
// from the repository's node_modules so the bundle cannot drift from the tree
// the tests actually ran against.
const PROD_DEPENDENCIES = [
  "express",
  "ws",
  "node-pty",
  "@xterm/headless",
  "@xterm/addon-serialize",
];

function resolvePackageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function assertBundleHost() {
  if (process.platform !== "win32") {
    throw new Error(
      `packaging currently supports Windows only (got ${process.platform})`,
    );
  }
}

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function describeCause(error) {
  return (
    error?.cause?.code || error?.cause?.message || error?.message || "unknown"
  );
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = attempt * 2000;
        console.log(
          `[package] fetch failed (${describeCause(error)}); retrying ${url} in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw new Error(
    `fetch failed after ${attempts} attempts: ${url} (${describeCause(lastError)})`,
  );
}

async function downloadToFile(url, destination) {
  console.log(`[package] downloading ${url}`);
  const response = await fetchWithRetry(url);
  if (!response.body) {
    throw new Error(`download has no body: ${url}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

async function fetchNodeExe() {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachedPath = join(CACHE_DIR, `node-v${NODE_VERSION}-win-x64.exe`);

  const shasumsResponse = await fetchWithRetry(
    `${NODE_DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt`,
  );
  const shasums = await shasumsResponse.text();
  const expectedLine = shasums
    .split("\n")
    .find((line) => line.trimEnd().endsWith(`win-x64/node.exe`));
  if (!expectedLine) {
    throw new Error(
      `SHASUMS256.txt for v${NODE_VERSION} has no win-x64/node.exe entry`,
    );
  }
  const expectedSha256 = expectedLine.trim().split(/\s+/)[0];

  const cachedExists = existsSync(cachedPath);
  if (cachedExists && (await fileSha256(cachedPath)) === expectedSha256) {
    console.log(`[package] using cached node.exe v${NODE_VERSION}`);
    return cachedPath;
  }
  if (cachedExists) {
    console.log("[package] cached node.exe failed checksum; re-downloading");
  }

  await downloadToFile(
    `${NODE_DIST_BASE}/v${NODE_VERSION}/win-x64/node.exe`,
    cachedPath,
  );
  const actualSha256 = await fileSha256(cachedPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `node.exe checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  console.log(`[package] node.exe v${NODE_VERSION} checksum verified`);
  return cachedPath;
}

async function copyIntoStaging() {
  for (const relativeDir of ["server/dist", "web/dist"]) {
    if (!existsSync(join(PACKAGE_ROOT, ...relativeDir.split("/")))) {
      throw new Error(
        `${relativeDir} is missing; run "npm run build" before packaging`,
      );
    }
  }

  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(join(STAGING_DIR, "server"), { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "server", "dist"),
    join(STAGING_DIR, "server", "dist"),
    {
      recursive: true,
    },
  );
  // windowsConsoleInput.js resolves the helper relative to server/dist as
  // ../scripts/, so the bundle keeps the same neighbor layout.
  await mkdir(join(STAGING_DIR, "server", "scripts"), { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "server", "scripts", "windows-console-input.ps1"),
    join(STAGING_DIR, "server", "scripts", "windows-console-input.ps1"),
  );
  await cp(
    join(PACKAGE_ROOT, "web", "dist"),
    join(STAGING_DIR, "web", "dist"),
    {
      recursive: true,
    },
  );
}

async function installProductionDependencies(rootPackage) {
  const requireFromRoot = createRequire(join(PACKAGE_ROOT, "package.json"));
  const bundlePackage = {
    name: "termrail-bundle",
    version: rootPackage.version,
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      PROD_DEPENDENCIES.map((name) => [
        name,
        requireFromRoot(`${name}/package.json`).version,
      ]),
    ),
  };

  await writeFile(
    join(STAGING_DIR, "package.json"),
    `${JSON.stringify(bundlePackage, null, 2)}\n`,
  );
  console.log(
    "[package] installing production dependencies into the bundle...",
  );
  const installArgs = [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  // Windows refuses to spawn npm.cmd without a shell (BatBadBut mitigation),
  // so drive npm's JS entry directly when npm run gave us its path.
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...installArgs], {
        cwd: STAGING_DIR,
        stdio: "inherit",
        shell: false,
      })
    : spawnSync(`npm ${installArgs.join(" ")}`, {
        cwd: STAGING_DIR,
        stdio: "inherit",
        shell: true,
      });
  if (result.status !== 0) {
    const reason = result.error ? describeCause(result.error) : "";
    throw new Error(
      `npm install failed in the bundle with code ${result.status}${reason ? `: ${reason}` : ""}`,
    );
  }

  // @termrail/shared is a private workspace package, not on the registry.
  const sharedInBundle = join(
    STAGING_DIR,
    "node_modules",
    "@termrail",
    "shared",
  );
  await mkdir(sharedInBundle, { recursive: true });
  await cp(
    join(PACKAGE_ROOT, "shared", "package.json"),
    join(sharedInBundle, "package.json"),
  );
  await cp(join(PACKAGE_ROOT, "shared", "dist"), join(sharedInBundle, "dist"), {
    recursive: true,
  });
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(address.port));
    });
    probe.on("error", rejectPort);
  });
}

const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function verifyBundle(nodeExePath) {
  console.log("[package] verifying the bundle boots and serves the UI...");
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), "termrail-package-"));
  const child = spawn(nodeExePath, ["server/dist/index.js"], {
    cwd: STAGING_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AUTH_TOKEN: "",
      TERMRAIL_OPEN: "",
      PORT: String(port),
      CONFIG_PATH: join(configDir, "config.json"),
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(
          `bundle server exited early with code ${child.exitCode}`,
        );
      }
      try {
        const health = await fetch(`${baseUrl}/health`);
        if (health.ok) break;
      } catch {
        // server not listening yet
      }
      if (Date.now() > deadline) {
        throw new Error("bundle server did not become healthy within 30s");
      }
      await sleep(300);
    }

    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    if (!page.ok || !html.includes("<title>TermRail")) {
      throw new Error(
        `bundle does not serve the UI at / (status ${page.status})`,
      );
    }

    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "package-smoke",
        name: "Package Smoke",
        cwd: configDir,
        prompts: [],
      }),
    });
    if (sessionResponse.status !== 201) {
      throw new Error(
        `creating a session in the bundle failed with ${sessionResponse.status}`,
      );
    }

    // Starting a terminal proves the bundled node-pty prebuild actually loads.
    const terminalResponse = await fetch(
      `${baseUrl}/api/sessions/package-smoke/terminals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "pty-probe", command: "exit" }),
      },
    );
    if (terminalResponse.status !== 201) {
      throw new Error(
        `starting a PTY in the bundle failed with ${terminalResponse.status}`,
      );
    }

    const deleteResponse = await fetch(
      `${baseUrl}/api/sessions/package-smoke`,
      { method: "DELETE" },
    );
    if (!deleteResponse.ok) {
      throw new Error("cleaning up the smoke session failed");
    }

    console.log("[package] bundle verification passed");
  } finally {
    child.kill();
    await rm(configDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function zipBundle() {
  const rootPackage = JSON.parse(
    await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const zipPath = join(
    RELEASE_DIR,
    `TermRail-v${rootPackage.version}-win-x64.zip`,
  );
  await rm(zipPath, { force: true });
  console.log("[package] compressing the bundle...");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${STAGING_DIR}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed with code ${result.status}`);
  }
  return zipPath;
}

async function main() {
  assertBundleHost();

  const rootPackage = JSON.parse(
    await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  console.log(`[package] packaging TermRail v${rootPackage.version} (win-x64)`);

  const nodeExePath = await fetchNodeExe();
  await copyIntoStaging();
  await installProductionDependencies(rootPackage);
  await cp(nodeExePath, join(STAGING_DIR, "node.exe"));
  await cp(
    join(PACKAGE_ROOT, "scripts", "start.cmd"),
    join(STAGING_DIR, "start.cmd"),
  );

  await verifyBundle(join(STAGING_DIR, "node.exe"));
  const zipPath = await zipBundle();

  console.log(`[package] bundle folder: ${STAGING_DIR}`);
  console.log(`[package] distribution zip: ${zipPath}`);
}

main().catch((error) => {
  console.error(`[package] ${error.message}`);
  if (error.cause) {
    console.error(`[package] cause: ${describeCause(error)}`);
  }
  process.exit(1);
});
