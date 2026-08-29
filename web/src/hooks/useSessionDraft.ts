import { useState } from "react";
import {
  defaultTerminalId,
  idPattern,
  type PromptExample,
  type SessionConfig,
  type TerminalConfig,
} from "@termrail/shared";
import { makeLocalId } from "../utils/id";

export type SessionDraft = {
  id: string;
  name: string;
  cwd: string;
  command: string;
};

export type SessionEditorState = {
  mode: "create" | "edit";
  originalId: string | null;
};

export function newSessionDraft(): SessionDraft {
  return {
    id: makeLocalId("session"),
    name: "",
    cwd: ".",
    command: "",
  };
}

export function draftFromSession(session: SessionConfig): SessionDraft {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    command: session.command,
  };
}

export function sessionFromDraft(
  draft: SessionDraft,
  prompts: PromptExample[],
  terminals?: TerminalConfig[],
): SessionConfig {
  const command = draft.command.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    cwd: draft.cwd.trim(),
    command,
    terminals: terminals ?? [
      {
        id: defaultTerminalId,
        name: "Main",
        command,
      },
    ],
    prompts,
  };
}

export function validateSessionDraft(draft: SessionDraft): string | null {
  const session = sessionFromDraft(draft, []);

  if (!session.id || !session.name || !session.cwd || !session.command) {
    return "id, name, cwd, and command are required";
  }

  if (!idPattern.test(session.id)) {
    return 'id must start with a letter or number and contain only letters, numbers, "_" or "-"';
  }

  return null;
}

export function useSessionDraft() {
  const [draft, setDraft] = useState<SessionDraft>(() => newSessionDraft());

  const updateDraft = (field: keyof SessionDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const resetDraft = () => {
    setDraft(newSessionDraft());
  };

  const loadDraft = (session: SessionConfig) => {
    setDraft(draftFromSession(session));
  };

  return {
    draft,
    loadDraft,
    resetDraft,
    setDraft,
    updateDraft,
  };
}
