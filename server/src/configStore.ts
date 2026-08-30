import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type {
  AppConfig,
  PromptExample,
  SessionConfig,
  TerminalConfig,
} from "./types.js";
import { HttpError } from "./errors.js";
import {
  promptsFromInput,
  sessionFromInput,
  sessionsFromConfig,
  terminalFromInput,
} from "./validation.js";

function clonePrompts(prompts: PromptExample[]): PromptExample[] {
  return prompts.map((prompt) => ({ ...prompt }));
}

function cloneTerminals(terminals: TerminalConfig[]): TerminalConfig[] {
  return terminals.map((terminal) => ({ ...terminal }));
}

function cloneSession(session: SessionConfig): SessionConfig {
  return {
    ...session,
    terminals: cloneTerminals(session.terminals),
    prompts: clonePrompts(session.prompts),
  };
}

export class ConfigStore {
  private config: AppConfig = { prompts: [], sessions: [] };
  private updateQueue: Promise<void> = Promise.resolve();

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
      this.config = { prompts: [], sessions: [] };
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(this.config, null, 2)}\n`,
        "utf8",
      );
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  listSessions(): SessionConfig[] {
    return this.config.sessions.map(cloneSession);
  }

  listPrompts(): PromptExample[] {
    return clonePrompts(this.config.prompts);
  }

  getSession(id: string): SessionConfig | null {
    const session = this.config.sessions.find((item) => item.id === id);
    return session ? cloneSession(session) : null;
  }

  listTerminals(sessionId: string): TerminalConfig[] {
    const session = this.config.sessions.find((item) => item.id === sessionId);
    return session ? cloneTerminals(session.terminals) : [];
  }

  getTerminal(sessionId: string, terminalId: string): TerminalConfig | null {
    const terminal = this.config.sessions
      .find((session) => session.id === sessionId)
      ?.terminals.find((item) => item.id === terminalId);
    return terminal ? { ...terminal } : null;
  }

  async createSession(input: unknown): Promise<SessionConfig> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(
        400,
        "INVALID_SESSION",
        "Session must be a JSON object",
      );
    }
    const request = input as Record<string, unknown>;
    if ("command" in request) {
      throw new HttpError(
        400,
        "INVALID_SESSION",
        "Session commands are not supported; create a terminal instead",
      );
    }
    if ("terminals" in request) {
      throw new HttpError(
        400,
        "TERMINALS_READ_ONLY",
        "Session terminals must be managed through the terminal endpoints",
      );
    }
    const session = sessionFromInput(input, { generateId: true });
    return await this.updateConfig(() => {
      if (this.config.sessions.some((item) => item.id === session.id)) {
        throw new HttpError(
          409,
          "SESSION_EXISTS",
          `Session "${session.id}" already exists`,
        );
      }
      this.config.sessions.push(session);
      return cloneSession(session);
    });
  }

  async updateSession(id: string, input: unknown): Promise<SessionConfig> {
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
    if ("command" in patch) {
      throw new HttpError(
        400,
        "INVALID_SESSION",
        "Session commands are not supported; edit the terminal instead",
      );
    }
    if ("terminals" in patch) {
      throw new HttpError(
        400,
        "TERMINALS_READ_ONLY",
        "Session terminals must be managed through the terminal endpoints",
      );
    }

    return await this.updateConfig(() => {
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

      const current = this.config.sessions[index];
      const parsed = sessionFromInput({ ...current, ...patch, id }, { id });
      this.config.sessions[index] = parsed;
      return cloneSession(parsed);
    });
  }

  async updatePrompts(input: unknown): Promise<PromptExample[]> {
    const prompts = promptsFromInput(input);
    return await this.updateConfig(() => {
      this.config.prompts = prompts;
      return clonePrompts(prompts);
    });
  }

  async createTerminal(
    sessionId: string,
    input: unknown,
  ): Promise<TerminalConfig> {
    return await this.updateConfig(() => {
      const session = this.config.sessions.find(
        (item) => item.id === sessionId,
      );
      if (!session) {
        throw new HttpError(
          404,
          "SESSION_NOT_FOUND",
          `Session "${sessionId}" was not found`,
        );
      }

      const terminal = terminalFromInput(input, { generateId: true });
      if (session.terminals.some((item) => item.id === terminal.id)) {
        throw new HttpError(
          409,
          "TERMINAL_EXISTS",
          `Terminal "${terminal.id}" already exists`,
        );
      }

      session.terminals.push(terminal);
      return { ...terminal };
    });
  }

  async updateTerminal(
    sessionId: string,
    terminalId: string,
    input: unknown,
  ): Promise<TerminalConfig> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(
        400,
        "INVALID_TERMINAL",
        "Terminal update must be a JSON object",
      );
    }

    const patch = input as Record<string, unknown>;
    if (typeof patch.id === "string" && patch.id.trim() !== terminalId) {
      throw new HttpError(
        400,
        "INVALID_TERMINAL",
        "Terminal id cannot be changed",
      );
    }

    return await this.updateConfig(() => {
      const session = this.config.sessions.find(
        (item) => item.id === sessionId,
      );
      if (!session) {
        throw new HttpError(
          404,
          "SESSION_NOT_FOUND",
          `Session "${sessionId}" was not found`,
        );
      }

      const index = session.terminals.findIndex(
        (terminal) => terminal.id === terminalId,
      );
      if (index === -1) {
        throw new HttpError(
          404,
          "TERMINAL_NOT_FOUND",
          `Terminal "${terminalId}" was not found`,
        );
      }

      const terminal = terminalFromInput(
        { ...session.terminals[index], ...patch },
        { id: terminalId },
      );
      session.terminals[index] = terminal;
      return { ...terminal };
    });
  }

  async deleteTerminal(
    sessionId: string,
    terminalId: string,
  ): Promise<TerminalConfig> {
    return await this.updateConfig(() => {
      const session = this.config.sessions.find(
        (item) => item.id === sessionId,
      );
      if (!session) {
        throw new HttpError(
          404,
          "SESSION_NOT_FOUND",
          `Session "${sessionId}" was not found`,
        );
      }

      const index = session.terminals.findIndex(
        (terminal) => terminal.id === terminalId,
      );
      if (index === -1) {
        throw new HttpError(
          404,
          "TERMINAL_NOT_FOUND",
          `Terminal "${terminalId}" was not found`,
        );
      }

      const [removed] = session.terminals.splice(index, 1);
      return { ...removed };
    });
  }

  async deleteSession(id: string): Promise<SessionConfig> {
    return await this.updateConfig(() => {
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
      return cloneSession(removed);
    });
  }

  private async updateConfig<T>(mutator: () => T): Promise<T> {
    const update = this.updateQueue.then(async () => {
      const previousConfig = {
        prompts: clonePrompts(this.config.prompts),
        sessions: this.config.sessions.map(cloneSession),
      };
      try {
        const result = mutator();
        await this.save();
        return result;
      } catch (error) {
        this.config = previousConfig;
        throw error;
      }
    });

    this.updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return await update;
  }
}
