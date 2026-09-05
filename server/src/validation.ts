import { randomUUID } from "node:crypto";
import { idPattern } from "@termrail/shared";
import type {
  AppConfig,
  PromptExample,
  SessionConfig,
  TerminalConfig,
} from "./types.js";
import { HttpError } from "./errors.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanCommand(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function requireId(
  value: unknown,
  field: string,
  errors: string[],
): string | null {
  const id = cleanString(value);
  if (!id) {
    errors.push(`${field} must be a non-empty string`);
    return null;
  }
  if (!idPattern.test(id)) {
    errors.push(
      `${field} must start with a letter or number and contain only letters, numbers, "_" or "-"`,
    );
    return null;
  }
  return id;
}

function parsePrompts(
  value: unknown,
  errors: string[],
  field = "prompts",
): PromptExample[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }

  const prompts: PromptExample[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const promptErrors: string[] = [];
    const record = asRecord(item);
    if (!record) {
      errors.push(`${field}[${index}] must be an object`);
      return;
    }

    const id = requireId(record.id, `${field}[${index}].id`, promptErrors);
    const title = cleanString(record.title);
    const text = typeof record.text === "string" ? record.text : null;

    if (!title) {
      promptErrors.push(`${field}[${index}].title must be a non-empty string`);
    }
    if (text === null) {
      promptErrors.push(`${field}[${index}].text must be a string`);
    }
    if (id && seen.has(id)) {
      promptErrors.push(`${field}[${index}].id must be unique`);
    }

    if (promptErrors.length > 0 || !id || !title || text === null) {
      errors.push(...promptErrors);
      return;
    }

    seen.add(id);
    prompts.push({ id, title, text });
  });

  return prompts;
}

function parseTerminals(
  value: unknown,
  errors: string[],
  field = "terminals",
): TerminalConfig[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }

  const terminals: TerminalConfig[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const terminalErrors: string[] = [];
    const record = asRecord(item);
    if (!record) {
      errors.push(`${field}[${index}] must be an object`);
      return;
    }

    const id = requireId(record.id, `${field}[${index}].id`, terminalErrors);
    const name = cleanString(record.name);
    const command = cleanCommand(record.command);

    if (!name) {
      terminalErrors.push(`${field}[${index}].name must be a non-empty string`);
    }
    if (command === null) {
      terminalErrors.push(`${field}[${index}].command must be a string`);
    }
    if (id && seen.has(id)) {
      terminalErrors.push(`${field}[${index}].id must be unique`);
    }

    if (terminalErrors.length > 0 || !id || !name || command === null) {
      errors.push(...terminalErrors);
      return;
    }

    seen.add(id);
    terminals.push({ id, name, command });
  });

  return terminals;
}

export function terminalFromInput(
  value: unknown,
  options: {
    generateId?: boolean;
    id?: string;
  } = {},
): TerminalConfig {
  const errors: string[] = [];
  const record = asRecord(value);

  if (!record) {
    throw new HttpError(
      400,
      "INVALID_TERMINAL",
      "Terminal must be a JSON object",
    );
  }

  const explicitId = options.id ?? cleanString(record.id);
  const id = explicitId ?? (options.generateId ? randomUUID() : null);
  if (id) {
    requireId(id, "id", errors);
  } else {
    errors.push("id must be a non-empty string");
  }

  const name = cleanString(record.name);
  const command = cleanCommand(record.command);

  if (!name) {
    errors.push("name must be a non-empty string");
  }
  if (command === null) {
    errors.push("command must be a string");
  }

  if (errors.length > 0 || !id || !name || command === null) {
    throw new HttpError(
      400,
      "INVALID_TERMINAL",
      "Terminal validation failed",
      errors,
    );
  }

  return { id, name, command };
}

export function promptsFromInput(value: unknown): PromptExample[] {
  const errors: string[] = [];
  const record = asRecord(value);
  const promptsValue = record && "prompts" in record ? record.prompts : value;
  const prompts = parsePrompts(promptsValue, errors);

  if (errors.length > 0) {
    throw new HttpError(
      400,
      "INVALID_PROMPTS",
      "Prompt validation failed",
      errors,
    );
  }

  return prompts;
}

function collectLegacyPrompts(sessions: SessionConfig[]): PromptExample[] {
  const prompts: PromptExample[] = [];
  const seen = new Set<string>();

  sessions.forEach((session) => {
    session.prompts.forEach((prompt) => {
      if (seen.has(prompt.id)) {
        return;
      }
      seen.add(prompt.id);
      prompts.push({ ...prompt });
    });
  });

  return prompts;
}

export function sessionFromInput(
  value: unknown,
  options: {
    id?: string;
    generateId?: boolean;
    migrateLegacyCommand?: boolean;
  } = {},
): SessionConfig {
  const errors: string[] = [];
  const record = asRecord(value);

  if (!record) {
    throw new HttpError(
      400,
      "INVALID_SESSION",
      "Session must be a JSON object",
    );
  }

  const explicitId = options.id ?? cleanString(record.id);
  const id = explicitId ?? (options.generateId ? randomUUID() : null);
  if (id) {
    requireId(id, "id", errors);
  } else {
    errors.push("id must be a non-empty string");
  }

  const name = cleanString(record.name);
  const cwd = cleanString(record.cwd);
  const promptsValue = record.prompts ?? [];
  const legacyCommand = options.migrateLegacyCommand
    ? cleanString(record.command)
    : null;
  const shouldMigrateLegacyCommand =
    legacyCommand !== null &&
    (record.terminals == null ||
      (Array.isArray(record.terminals) && record.terminals.length === 0));
  const terminalsValue = shouldMigrateLegacyCommand
    ? [{ id: "main", name: "Main", command: legacyCommand }]
    : (record.terminals ?? []);

  if (!name) {
    errors.push("name must be a non-empty string");
  }
  if (!cwd) {
    errors.push("cwd must be a non-empty string");
  }
  const prompts = parsePrompts(promptsValue, errors);
  const terminals = parseTerminals(terminalsValue, errors);

  if (errors.length > 0 || !id || !name || !cwd) {
    throw new HttpError(
      400,
      "INVALID_SESSION",
      "Session validation failed",
      errors,
    );
  }

  return { id, name, cwd, terminals, prompts };
}

export function sessionsFromConfig(value: unknown): {
  config: AppConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const record = asRecord(value);

  if (!record || !Array.isArray(record.sessions)) {
    return {
      config: { prompts: [], sessions: [] },
      warnings: ["config must be an object with a sessions array"],
    };
  }

  const sessions: SessionConfig[] = [];
  const seen = new Set<string>();

  record.sessions.forEach((item, index) => {
    try {
      const session = sessionFromInput(item, { migrateLegacyCommand: true });
      const itemRecord = asRecord(item);
      if (itemRecord && "command" in itemRecord) {
        const legacyCommand = cleanString(itemRecord.command);
        const migrated =
          legacyCommand !== null &&
          (itemRecord.terminals == null ||
            (Array.isArray(itemRecord.terminals) &&
              itemRecord.terminals.length === 0));
        warnings.push(
          migrated
            ? `sessions[${index}].command is deprecated and was migrated to a Main terminal`
            : legacyCommand === null
              ? `sessions[${index}].command is deprecated and was ignored because it is empty`
              : `sessions[${index}].command is deprecated and was ignored because terminals are already configured`,
        );
      }
      if (seen.has(session.id)) {
        warnings.push(
          `sessions[${index}] skipped: duplicate id "${session.id}"`,
        );
        return;
      }
      seen.add(session.id);
      sessions.push(session);
    } catch (error) {
      if (error instanceof HttpError) {
        warnings.push(
          `sessions[${index}] skipped: ${JSON.stringify(error.details ?? error.message)}`,
        );
        return;
      }
      warnings.push(`sessions[${index}] skipped: unknown validation error`);
    }
  });

  let prompts: PromptExample[] = [];
  if (record.prompts === undefined) {
    prompts = collectLegacyPrompts(sessions);
  } else {
    const promptWarnings: string[] = [];
    prompts = parsePrompts(record.prompts, promptWarnings);
    warnings.push(...promptWarnings);
  }

  return { config: { prompts, sessions }, warnings };
}
