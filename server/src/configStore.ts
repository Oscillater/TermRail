import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AppConfig, SessionConfig } from "./types.js";
import { HttpError } from "./errors.js";
import { sessionFromInput, sessionsFromConfig } from "./validation.js";

function cloneSession(session: SessionConfig): SessionConfig {
  return {
    ...session,
    prompts: session.prompts.map((prompt) => ({ ...prompt })),
  };
}

export class ConfigStore {
  private config: AppConfig = { sessions: [] };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.save();
        return;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const { config, warnings } = sessionsFromConfig(parsed);
      this.config = config;
      warnings.forEach((warning) => console.warn(`[config] ${warning}`));
    } catch (error) {
      console.warn(
        `[config] failed to parse ${this.filePath}; using an empty in-memory config`,
      );
      if (error instanceof Error) {
        console.warn(`[config] ${error.message}`);
      }
      this.config = { sessions: [] };
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.config, null, 2)}\n`,
      "utf8",
    );
  }

  listSessions(): SessionConfig[] {
    return this.config.sessions.map(cloneSession);
  }

  getSession(id: string): SessionConfig | null {
    const session = this.config.sessions.find((item) => item.id === id);
    return session ? cloneSession(session) : null;
  }

  async createSession(input: unknown): Promise<SessionConfig> {
    const session = sessionFromInput(input, { generateId: true });
    if (this.config.sessions.some((item) => item.id === session.id)) {
      throw new HttpError(
        409,
        "SESSION_EXISTS",
        `Session "${session.id}" already exists`,
      );
    }
    this.config.sessions.push(session);
    await this.save();
    return cloneSession(session);
  }

  async updateSession(id: string, input: unknown): Promise<SessionConfig> {
    const index = this.config.sessions.findIndex(
      (session) => session.id === id,
    );
    if (index === -1) {
      throw new HttpError(
        404,
        "SESSION_NOT_FOUND",
        `Session "${id}" was not found`,
      );
    }

    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(
        400,
        "INVALID_SESSION",
        "Session update must be a JSON object",
      );
    }

    const patch = input as Record<string, unknown>;
    if (typeof patch.id === "string" && patch.id.trim() !== id) {
      throw new HttpError(
        400,
        "INVALID_SESSION",
        "Session id cannot be changed",
      );
    }

    const updated = sessionFromInput(
      { ...this.config.sessions[index], ...patch, id },
      { id },
    );
    this.config.sessions[index] = updated;
    await this.save();
    return cloneSession(updated);
  }

  async deleteSession(id: string): Promise<SessionConfig> {
    const index = this.config.sessions.findIndex(
      (session) => session.id === id,
    );
    if (index === -1) {
      throw new HttpError(
        404,
        "SESSION_NOT_FOUND",
        `Session "${id}" was not found`,
      );
    }

    const [removed] = this.config.sessions.splice(index, 1);
    await this.save();
    return cloneSession(removed);
  }
}
