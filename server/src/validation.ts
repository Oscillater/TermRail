import { randomUUID } from "node:crypto";
import { idPattern } from "@termrail/shared";
import type { AppConfig, PromptExample, SessionConfig } from "./types.js";
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
  options: { id?: string; generateId?: boolean } = {},
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
  const command = cleanString(record.command);
  const promptsValue = record.prompts ?? [];

  if (!name) {
    errors.push("name must be a non-empty string");
  }
  if (!cwd) {
    errors.push("cwd must be a non-empty string");
  }
  if (!command) {
    errors.push("command must be a non-empty string");
  }

  const prompts = parsePrompts(promptsValue, errors);

  if (errors.length > 0 || !id || !name || !cwd || !command) {
    throw new HttpError(
      400,
      "INVALID_SESSION",
      "Session validation failed",
      errors,
    );
  }

  return { id, name, cwd, command, prompts };
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
      const session = sessionFromInput(item);
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
