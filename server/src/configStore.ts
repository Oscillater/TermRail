import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { defaultTerminalId } from "@termrail/shared";
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

function terminalsEqual(
  left: TerminalConfig[],
  right: TerminalConfig[],
): boolean {
  return (
    left.length === right.length &&
    left.every((terminal, index) => {
      const other = right[index];
      if (!other) {
        return false;
      }
      return (
        terminal.id === other.id &&
        terminal.name === other.name &&
        terminal.command === other.command
      );
    })
  );
}

function syncDefaultTerminalCommand(
  terminals: TerminalConfig[],
  previousCommand: string,
  nextCommand: string,
): TerminalConfig[] {
  return terminals.map((terminal) =>
    terminal.id === defaultTerminalId && terminal.command === previousCommand
      ? { ...terminal, command: nextCommand }
      : { ...terminal },
  );
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
      if (
        "terminals" in patch &&
        !terminalsEqual(parsed.terminals, current.terminals)
      ) {
        throw new HttpError(
          400,
          "TERMINALS_READ_ONLY",
          "Session terminals must be managed through the terminal endpoints",
        );
      }

      const updated: SessionConfig = {
        ...parsed,
        terminals: syncDefaultTerminalCommand(
          current.terminals,
          current.command,
          parsed.command,
        ),
      };
      this.config.sessions[index] = updated;
      return cloneSession(updated);
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

      const terminal = terminalFromInput(input, {
        defaultCommand: session.command,
        generateId: true,
      });
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
