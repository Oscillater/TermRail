import type { Ref } from "react";

export type TerminalEditorDraft = {
  name: string;
  command: string;
};

export type TerminalEditorFormMode = "create" | "edit";

type TerminalEditorFormProps = {
  commandInputRef: Ref<HTMLInputElement>;
  draft: TerminalEditorDraft;
  error: string | null;
  mode: TerminalEditorFormMode;
  onCancel: () => void;
  onChange: (draft: TerminalEditorDraft) => void;
  onSubmit: () => void;
  saving: boolean;
};

export function TerminalEditorForm({
  commandInputRef,
  draft,
  error,
  mode,
  onCancel,
  onChange,
  onSubmit,
  saving,
}: TerminalEditorFormProps) {
  return (
    <>
      <form
        className="terminal-new-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          autoFocus
          disabled={saving}
          onChange={(event) =>
            onChange({
              ...draft,
              name: event.target.value,
            })
          }
          placeholder="Name"
          required
          value={draft.name}
        />
        <input
          disabled={saving}
          onChange={(event) =>
            onChange({
              ...draft,
              command: event.target.value,
            })
          }
          placeholder="Command"
          ref={commandInputRef}
          value={draft.command}
        />
        <button
          className="primary-button compact"
          disabled={saving}
          type="submit"
        >
          {saving
            ? mode === "edit"
              ? "Saving"
              : "Creating"
            : mode === "edit"
              ? "Save"
              : "Create"}
        </button>
        <button
          className="ghost-button compact"
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}
