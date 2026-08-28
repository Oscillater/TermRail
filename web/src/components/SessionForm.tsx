import { type FormEvent, useState } from "react";
import type {
  SessionDraft,
  SessionEditorState,
} from "../hooks/useSessionDraft";
import { DirectoryPicker } from "./DirectoryPicker";

type SessionFormProps = {
  draft: SessionDraft;
  editor: SessionEditorState;
  error: string | null;
  onChange: (field: keyof SessionDraft, value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
};

export function SessionForm({
  draft,
  editor,
  error,
  onChange,
  onClose,
  onSubmit,
  saving,
}: SessionFormProps) {
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  const closeForm = () => {
    setDirectoryPickerOpen(false);
    onClose();
  };

  return (
    <form className="side-form" onSubmit={handleSubmit}>
      <div className="form-title-row">
        <h2>{editor.mode === "create" ? "Add Session" : "Edit Session"}</h2>
        <button
          className="ghost-button compact"
          disabled={saving}
          onClick={closeForm}
          type="button"
        >
          Close
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <label>
        <span>ID</span>
        <input
          disabled={saving || editor.mode === "edit"}
          onChange={(event) => onChange("id", event.target.value)}
          required
          value={draft.id}
        />
      </label>
      <label>
        <span>Name</span>
        <input
          disabled={saving}
          onChange={(event) => onChange("name", event.target.value)}
          required
          value={draft.name}
        />
      </label>
      <div className="form-field">
        <span className="field-label">CWD</span>
        <div className="input-row">
          <input
            disabled={saving}
            onChange={(event) => onChange("cwd", event.target.value)}
            required
            value={draft.cwd}
          />
          <button
            className="ghost-button"
            disabled={saving}
            onClick={() => setDirectoryPickerOpen(true)}
            type="button"
          >
            Browse
          </button>
        </div>
      </div>
      {directoryPickerOpen ? (
        <DirectoryPicker
          disabled={saving}
          onClose={() => setDirectoryPickerOpen(false)}
          onSelect={(path) => onChange("cwd", path)}
          value={draft.cwd}
        />
      ) : null}
      <label>
        <span>Command</span>
        <input
          disabled={saving}
          onChange={(event) => onChange("command", event.target.value)}
          required
          value={draft.command}
        />
      </label>
      <div className="form-actions">
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Saving" : "Save"}
        </button>
        <button
          className="ghost-button"
          disabled={saving}
          onClick={closeForm}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
