import { useState } from "react";
import {
  idPattern,
  type PromptExample,
  type SessionConfig,
} from "@termrail/shared";
import { makeLocalId } from "../utils/id";

export type SessionDraft = {
  id: string;
  name: string;
  cwd: string;
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
  };
}

export function draftFromSession(session: SessionConfig): SessionDraft {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
  };
}

export function sessionFromDraft(
  draft: SessionDraft,
  prompts: PromptExample[],
): Omit<SessionConfig, "terminals"> {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    cwd: draft.cwd.trim(),
    prompts,
  };
}

export function validateSessionDraft(draft: SessionDraft): string | null {
  const session = sessionFromDraft(draft, []);

  if (!session.id || !session.name || !session.cwd) {
    return "id, name, and cwd are required";
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
