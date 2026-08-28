import { useCallback, useEffect, useState } from "react";
import { jsonRequest } from "../api";
import type {
  DirectoryEntry,
  DirectoryListing,
  DirectoryRootsResponse,
} from "../types";
import { messageFromError } from "../utils/errors";

type DirectoryPickerProps = {
  disabled: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  value: string;
};

export function DirectoryPicker({
  disabled,
  onClose,
  onSelect,
  value,
}: DirectoryPickerProps) {
  const [roots, setRoots] = useState<DirectoryEntry[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoots = useCallback(async () => {
    try {
      const data = await jsonRequest<DirectoryRootsResponse>(
        "/api/filesystem/roots",
      );
      setRoots(data.roots);
    } catch (requestError) {
      setError(messageFromError(requestError, "Failed to load folders"));
    }
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await jsonRequest<DirectoryListing>(
        `/api/filesystem/directories?path=${encodeURIComponent(path)}`,
      );
      setListing(data);
    } catch (requestError) {
      setError(messageFromError(requestError, "Failed to load folders"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
    void loadDirectory(value || ".");
  }, [loadDirectory, loadRoots, value]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, onClose]);

  return (
    <div
      className="directory-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !disabled) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        aria-labelledby="directory-picker-title"
        aria-modal="true"
        className="directory-picker"
        role="dialog"
      >
        <div className="directory-picker-header">
          <div>
            <span className="field-label">Folder</span>
            <h2 id="directory-picker-title">Choose CWD</h2>
            <p>{listing?.path ?? value}</p>
          </div>
          <button
            className="ghost-button compact"
            disabled={disabled}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        <div className="directory-roots">
          {roots.map((root) => (
            <button
              disabled={disabled || loading}
              key={root.path}
              onClick={() => void loadDirectory(root.path)}
              type="button"
            >
              {root.name}
            </button>
          ))}
        </div>

        <div className="directory-list">
          {listing?.parentPath ? (
            <button
              disabled={disabled || loading}
              onClick={() => void loadDirectory(listing.parentPath ?? ".")}
              type="button"
            >
              ..
            </button>
          ) : null}
          {loading ? (
            <p className="directory-empty">Loading folders...</p>
          ) : null}
          {!loading && listing && listing.entries.length === 0 ? (
            <p className="directory-empty">No subfolders.</p>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              disabled={disabled || loading}
              key={entry.path}
              onClick={() => void loadDirectory(entry.path)}
              type="button"
            >
              {entry.name}
            </button>
          ))}
        </div>

        <div className="form-actions">
          <button
            className="primary-button"
            disabled={disabled || !listing}
            onClick={() => {
              if (listing) {
                onSelect(listing.path);
                onClose();
              }
            }}
            type="button"
          >
            Use Folder
          </button>
          <button
            className="ghost-button"
            disabled={disabled}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
