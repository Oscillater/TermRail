import { type FormEvent, useEffect, useState } from "react";
import type { PromptExample, RuntimeStatus, SessionConfig } from "../types";
import { writeClipboardText } from "../utils/clipboard";
import { messageFromError } from "../utils/errors";
import { makeLocalId } from "../utils/id";

type PromptPanelProps = {
  collapsed: boolean;
  error: string | null;
  onTerminalInput: (data: string) => void;
  onToggleCollapsed: () => void;
  onUpdatePrompts: (prompts: PromptExample[]) => Promise<PromptExample[]>;
  prompts: PromptExample[];
  promptsLoaded: boolean;
  session: SessionConfig | null;
  status: RuntimeStatus | undefined;
};

type PromptDraft = {
  id: string;
  title: string;
  text: string;
};

type PromptEditorState = {
  mode: "create" | "edit";
  originalId: string | null;
};

type PromptDraftCacheEntry = {
  draft: PromptDraft;
  editor: PromptEditorState;
  updatedAt: number;
};

const promptDraftCacheKey = "termrail.promptDraft.v2";

function newPromptDraft(): PromptDraft {
  return {
    id: makeLocalId("prompt"),
    title: "",
    text: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function promptDraftFromUnknown(value: unknown): PromptDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, title, text } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof text !== "string"
  ) {
    return null;
  }

  return { id, title, text };
}

function promptEditorFromUnknown(value: unknown): PromptEditorState | null {
  if (!isRecord(value)) {
    return null;
  }

  const mode = value.mode;
  const originalId = value.originalId;
  if (
    (mode !== "create" && mode !== "edit") ||
    (originalId !== null && typeof originalId !== "string")
  ) {
    return null;
  }

  return { mode, originalId };
}

function readPromptDraftCacheEntry(): PromptDraftCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(promptDraftCacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const draft = promptDraftFromUnknown(parsed.draft);
    const editor = promptEditorFromUnknown(parsed.editor);
    const updatedAt =
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0;

    return draft && editor ? { draft, editor, updatedAt } : null;
  } catch {
    return null;
  }
}

function writePromptDraftCacheEntry(entry: PromptDraftCacheEntry): void {
  try {
    window.localStorage.setItem(promptDraftCacheKey, JSON.stringify(entry));
  } catch {
    // Draft persistence is best-effort.
  }
}

function clearPromptDraftCacheEntry(): void {
  try {
    window.localStorage.removeItem(promptDraftCacheKey);
  } catch {
    // Draft persistence is best-effort.
  }
}

function draftFromPrompt(prompt: PromptExample): PromptDraft {
  return {
    id: prompt.id,
    title: prompt.title,
    text: prompt.text,
  };
}

export function PromptPanel({
  collapsed,
  error,
  onTerminalInput,
  onToggleCollapsed,
  onUpdatePrompts,
  prompts,
  promptsLoaded,
  session,
  status,
}: PromptPanelProps) {
  const running = status?.state === "running";
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(() => newPromptDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyingPromptId, setCopyingPromptId] = useState<string | null>(null);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);

  useEffect(() => {
    if (!promptsLoaded) {
      return;
    }

    const cached = readPromptDraftCacheEntry();
    const cachedPromptExists =
      cached?.editor.mode === "create" ||
      prompts.some((prompt) => prompt.id === cached?.editor.originalId);
    if (cached && cachedPromptExists) {
      setEditor(cached.editor);
      setDraft(cached.draft);
    } else {
      setEditor(null);
      setDraft(newPromptDraft());
    }
    setFormError(null);
    setNotice(null);
  }, [prompts, promptsLoaded]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    writePromptDraftCacheEntry({
      draft,
      editor,
      updatedAt: Date.now(),
    });
  }, [draft, editor]);

  const updateDraft = (field: keyof PromptDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const closePromptEditor = () => {
    clearPromptDraftCacheEntry();
    setEditor(null);
    setDraft(newPromptDraft());
    setFormError(null);
  };

  const openCreateEditor = () => {
    clearPromptDraftCacheEntry();
    setEditor({ mode: "create", originalId: null });
    setDraft(newPromptDraft());
    setFormError(null);
    setNotice(null);
  };

  const openEditEditor = (prompt: PromptExample) => {
    clearPromptDraftCacheEntry();
    setEditor({ mode: "edit", originalId: prompt.id });
    setDraft(draftFromPrompt(prompt));
    setFormError(null);
    setNotice(null);
  };

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) {
      return;
    }

    const prompt: PromptExample = {
      id: draft.id.trim(),
      title: draft.title.trim(),
      text: draft.text,
    };

    if (!prompt.id || !prompt.title) {
      setFormError("id and title are required");
      return;
    }

    const duplicate = prompts.some(
      (item) => item.id === prompt.id && item.id !== editor.originalId,
    );
    if (duplicate) {
      setFormError(`Prompt id "${prompt.id}" already exists`);
      return;
    }

    const nextPrompts =
      editor.mode === "create"
        ? [...prompts, prompt]
        : prompts.map((item) =>
            item.id === editor.originalId ? prompt : item,
          );

    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      await onUpdatePrompts(nextPrompts);
      clearPromptDraftCacheEntry();
      setEditor(null);
      setDraft(newPromptDraft());
    } catch (error) {
      setFormError(messageFromError(error, "Failed to save prompt"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePrompt = async (prompt: PromptExample) => {
    const confirmed = window.confirm(`Delete prompt "${prompt.title}"?`);
    if (!confirmed) {
      return;
    }

    setDeletingPromptId(prompt.id);
    setFormError(null);
    setNotice(null);
    try {
      await onUpdatePrompts(prompts.filter((item) => item.id !== prompt.id));
      if (editor?.originalId === prompt.id) {
        clearPromptDraftCacheEntry();
        setEditor(null);
        setDraft(newPromptDraft());
      }
    } catch (error) {
      setFormError(messageFromError(error, "Failed to delete prompt"));
    } finally {
      setDeletingPromptId(null);
    }
  };

  const handleCopyPrompt = async (prompt: PromptExample) => {
    setCopyingPromptId(prompt.id);
    setFormError(null);
    setNotice(null);
    try {
      await writeClipboardText(prompt.text);
      setNotice(`Copied "${prompt.title}"`);
    } catch (error) {
      setFormError(messageFromError(error, "Failed to copy prompt"));
    } finally {
      setCopyingPromptId(null);
    }
  };

  if (collapsed) {
    return (
      <aside
        aria-label="Prompt examples"
        className="prompt-panel panel-collapsed"
      >
        <button
          aria-expanded={false}
          aria-label="Show prompts panel"
          className="panel-rail-button"
          onClick={onToggleCollapsed}
          type="button"
        >
          <span className="panel-rail-title">Prompts</span>
          <span className="panel-rail-action">Show</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="prompt-panel" aria-label="Prompt examples">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Editable</p>
          <h2>Prompt Examples</h2>
        </div>
        <div className="panel-header-actions">
          <button
            aria-expanded={true}
            aria-label="Hide prompts panel"
            className="ghost-button compact collapse-button"
            onClick={onToggleCollapsed}
            type="button"
          >
            {">"}
          </button>
          <button
            className="primary-button"
            disabled={!promptsLoaded}
            onClick={openCreateEditor}
            type="button"
          >
            Add
          </button>
        </div>
      </div>

      {editor ? (
        <form className="side-form" onSubmit={handlePromptSubmit}>
          <div className="form-title-row">
            <h2>{editor.mode === "create" ? "Add Prompt" : "Edit Prompt"}</h2>
            <button
              className="ghost-button compact"
              disabled={saving}
              onClick={closePromptEditor}
              type="button"
            >
              Close
            </button>
          </div>
          {formError ? <div className="form-error">{formError}</div> : null}
          <label>
            <span>ID</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("id", event.target.value)}
              required
              value={draft.id}
            />
          </label>
          <label>
            <span>Title</span>
            <input
              disabled={saving}
              onChange={(event) => updateDraft("title", event.target.value)}
              required
              value={draft.title}
            />
          </label>
          <label>
            <span>Text</span>
            <textarea
              disabled={saving}
              onChange={(event) => updateDraft("text", event.target.value)}
              rows={8}
              value={draft.text}
            />
          </label>
          <div className="form-actions">
            <button className="primary-button" disabled={saving} type="submit">
              {saving ? "Saving" : "Save"}
            </button>
            <button
              className="ghost-button"
              disabled={saving}
              onClick={closePromptEditor}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {(formError || error) && !editor ? (
        <div className="form-error">{formError ?? error}</div>
      ) : null}
      {notice ? <div className="form-notice">{notice}</div> : null}

      <div className="prompt-list">
        {!promptsLoaded ? (
          <p className="empty-state">Loading prompt examples...</p>
        ) : null}
        {promptsLoaded && prompts.length === 0 ? (
          <p className="empty-state">No prompt examples configured.</p>
        ) : null}
        {promptsLoaded &&
          prompts.map((prompt) => (
            <article className="prompt-item" key={prompt.id}>
              <div className="prompt-title-row">
                <div>
                  <h3>{prompt.title}</h3>
                  <span className="prompt-id">{prompt.id}</span>
                </div>
              </div>
              <pre>{prompt.text || "(empty prompt)"}</pre>
              <div className="prompt-actions">
                <button
                  disabled={copyingPromptId === prompt.id}
                  onClick={() => void handleCopyPrompt(prompt)}
                  type="button"
                >
                  {copyingPromptId === prompt.id ? "Copying" : "Copy"}
                </button>
                <button
                  disabled={!running}
                  onClick={() => onTerminalInput(prompt.text)}
                  type="button"
                >
                  Insert
                </button>
                <button
                  disabled={!running}
                  onClick={() => onTerminalInput(`${prompt.text}\r`)}
                  type="button"
                >
                  Send
                </button>
                <button onClick={() => openEditEditor(prompt)} type="button">
                  Edit
                </button>
                <button
                  className="danger-button"
                  disabled={deletingPromptId === prompt.id}
                  onClick={() => void handleDeletePrompt(prompt)}
                  type="button"
                >
                  {deletingPromptId === prompt.id ? "Deleting" : "Delete"}
                </button>
              </div>
            </article>
          ))}
      </div>
    </aside>
  );
}
