import { homedir } from "node:os";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { HttpError } from "./errors.js";

export type DirectoryEntry = {
  name: string;
  path: string;
};

export type DirectoryListing = {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
};

const windowsDriveLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function displayName(path: string): string {
  const parsed = parse(path);
  if (path === parsed.root) {
    return parsed.root;
  }

  return parsed.base || path;
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ?? false;
}

function normalizeDirectoryPath(path: string, projectRoot: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return projectRoot;
  }

  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
}

function parentPathFor(path: string): string | null {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

export async function listDirectoryRoots(
  projectRoot: string,
): Promise<DirectoryEntry[]> {
  const candidates = [projectRoot, homedir()];

  if (process.platform === "win32") {
    candidates.push(...windowsDriveLetters.map((letter) => `${letter}:\\`));
  } else {
    candidates.push("/");
  }

  const seen = new Set<string>();
  const roots: DirectoryEntry[] = [];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    const key =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !(await isDirectory(resolved))) {
      continue;
    }

    seen.add(key);
    roots.push({
      name: displayName(resolved),
      path: resolved,
    });
  }

  return roots;
}

export async function listSubdirectories(
  projectRoot: string,
  path: string,
): Promise<DirectoryListing> {
  const directoryPath = normalizeDirectoryPath(path, projectRoot);
  const info = await stat(directoryPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new HttpError(
          404,
          "DIRECTORY_NOT_FOUND",
          `Directory was not found: ${path}`,
        );
      }
      throw error;
    },
  );

  if (!info.isDirectory()) {
    throw new HttpError(
      400,
      "NOT_A_DIRECTORY",
      `Path is not a directory: ${path}`,
    );
  }

  const dirents = await readdir(directoryPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw new HttpError(
          403,
          "DIRECTORY_UNREADABLE",
          `Directory cannot be read: ${path}`,
        );
      }
      throw error;
    },
  );

  const entries = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => ({
      name: dirent.name,
      path: resolve(directoryPath, dirent.name),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

  return {
    path: directoryPath,
    parentPath: parentPathFor(directoryPath),
    entries,
  };
}
