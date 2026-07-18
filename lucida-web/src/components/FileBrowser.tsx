import { useCallback, useEffect, useState } from "react";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import {
  browseLocalFiles,
  type BrowseEntry,
} from "../workspaceApi.ts";
import "./FileBrowser.css";

interface FileBrowserProps {
  /** Open the single navigated-to dataset into the CURRENT workspace (the
   *  in-viewer "Browse Local" flow). Optional so the browser can also be used
   *  purely to create a new workspace (#697) via `onCreateWorkspace`. */
  onSelect?: (path: string) => void;
  /** Create a NEW workspace from the selected dataset(s) (#697). When provided,
   *  the browser shows multi-select affordances (accumulate one or more zarr
   *  directories) and a "Create workspace from selection" action. Receives the
   *  canonical-form paths the user accumulated. */
  onCreateWorkspace?: (paths: string[]) => void;
  onClose: () => void;
}

/**
 * Cross-platform filesystem browser. The server owns "what's the root?"
 * — sending an empty `path` asks for the platform-default root:
 *   - Unix: listing of `/` (response `path` = `"/"`)
 *   - Windows: synthetic drives list `c:`, `d:`, … (response `path` = `""`)
 *
 * The component is platform-agnostic: it stores whatever path the server
 * returned and joins entries onto it with `/` (canonical form is always
 * forward-slash). On Windows the empty string is the explicit sentinel
 * for "synthetic drives root" so `"" + "/" + name` would yield a bogus
 * `"/c:"`; `navigateTo` special-cases the empty-root case.
 */
export function FileBrowser({
  onSelect,
  onCreateWorkspace,
  onClose,
}: FileBrowserProps) {
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, onClose });
  const [currentPath, setCurrentPath] = useState(() => {
    // On first-ever open `saved` is null → use `""`, which the server
    // interprets as "give me the platform-default root." This avoids
    // hardcoding `"/"` (broken on Windows) on the client.
    const saved = sessionStorage.getItem("lucida-browse-path");
    return saved ?? "";
  });
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasZarrJson, setHasZarrJson] = useState(false);
  // Accumulated dataset paths for the "create workspace from selection" flow
  // (#697). Only meaningful when `onCreateWorkspace` is provided; lets the user
  // walk to several zarr directories and collect them before creating.
  const [selected, setSelected] = useState<string[]>([]);
  const multiSelect = Boolean(onCreateWorkspace);
  const alreadySelected = selected.includes(currentPath);

  const browse = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await browseLocalFiles(path);
        setCurrentPath(data.path);
        setEntries(data.entries);
        setHasZarrJson(data.entries.some((e) => e.name === "zarr.json"));
        sessionStorage.setItem("lucida-browse-path", data.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    // Initial-mount fetch — `browse` setStates loading/entries internally.
    // The fetch IS the side effect we want; running it once on mount is the
    // intent (currentPath is already the prop value at this point).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    browse(currentPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = useCallback(
    (name: string) => {
      // Windows drives-root case: `currentPath` is `""` and entries are
      // already top-level paths like `c:` — joining with `"/"` would
      // produce a bogus `"/c:"` that doesn't canonicalize. Use the
      // entry name as the new path directly. On Unix `currentPath` is
      // `"/"` here, never empty, so the normal join branch applies.
      const next = currentPath ? `${currentPath}/${name}` : name;
      browse(next);
    },
    [browse, currentPath]
  );

  const navigateUp = useCallback(() => {
    // Strip the last `/segment` if there is one.
    const stripped = currentPath.replace(/\/[^/]*$/, "");
    if (stripped === currentPath) {
      // No `/` found — we're at a single-segment path like `c:`
      // (Windows drive root reached via the drives list). Going up
      // returns to the synthetic drives root (empty path).
      browse("");
      return;
    }
    if (stripped === "") {
      // Stripping took us back to platform root. On Unix this means
      // we were at `/foo` and the regex left `""`; sending `""` makes
      // the server reply with the platform-default root.
      browse("");
      return;
    }
    browse(stripped);
  }, [browse, currentPath]);

  const handleOpen = useCallback(() => {
    onSelect?.(currentPath);
    onClose();
  }, [currentPath, onSelect, onClose]);

  const handleAddToSelection = useCallback(() => {
    if (!hasZarrJson) return;
    setSelected((prev) => (prev.includes(currentPath) ? prev : [...prev, currentPath]));
  }, [currentPath, hasZarrJson]);

  const handleRemoveFromSelection = useCallback((path: string) => {
    setSelected((prev) => prev.filter((p) => p !== path));
  }, []);

  const handleCreateWorkspace = useCallback(() => {
    if (!onCreateWorkspace) return;
    // Include the current dataset if it's a zarr dir and not already collected,
    // so a single-dataset create works without an explicit "Add" click.
    const paths =
      hasZarrJson && !selected.includes(currentPath)
        ? [...selected, currentPath]
        : selected;
    if (paths.length === 0) return;
    onCreateWorkspace(paths);
    onClose();
  }, [onCreateWorkspace, hasZarrJson, selected, currentPath, onClose]);

  // Breadcrumb segments — works for both Unix (`/foo/bar`) and Windows
  // (`c:/Users/me`) because both use forward slashes throughout.
  const segments = currentPath.split("/").filter(Boolean);
  // Preserve a leading `/` when rebuilding segment paths so Unix paths
  // stay absolute (`/foo/bar`) and Windows paths stay drive-letter form
  // (`c:/Users/me`). The first character is the only signal we need.
  const leadingSlash = currentPath.startsWith("/") ? "/" : "";
  // True when we're at the platform-default root (synthetic drives root
  // on Windows, `/` on Unix). The `..` button and root-vs-not styling
  // both key off this.
  const atRoot = currentPath === "" || currentPath === "/";

  return (
    // Pointer users may dismiss through the backdrop; the dialog's Escape key
    // handler and explicit Close button provide the equivalent keyboard paths.
    <div
      role="presentation"
      className="file-browser-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape/focus-trap keys bubble from dialog controls. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-browser-title"
        aria-busy={loading}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="file-browser-dialog"
      >
        <div className="file-browser-header">
          <span id="file-browser-title" className="file-browser-title">
            Browse Local Files
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file browser"
            className="file-browser-icon-button"
          >
            ×
          </button>
        </div>

        <div className="file-browser-breadcrumbs">
          <button
            type="button"
            onClick={() => browse("")}
            className="file-browser-breadcrumb-button"
          >
            /
          </button>
          {segments.map((seg, i) => (
            <span key={`${seg}-${i}`} className="file-browser-breadcrumb-segment">
              <span className="file-browser-breadcrumb-separator">/</span>
              <button
                type="button"
                onClick={() =>
                  browse(leadingSlash + segments.slice(0, i + 1).join("/"))
                }
                className={`file-browser-breadcrumb-button${
                  i === segments.length - 1 ? " current" : ""
                }`}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        <div className="file-browser-list">
          {loading && (
            <div role="status" className="file-browser-status">
              Loading...
            </div>
          )}
          {error && (
            <div role="alert" className="file-browser-error">
              <span>{error}</span>
              <button
                type="button"
                className="file-browser-action"
                onClick={() => void browse(currentPath)}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && (
            <>
              {!atRoot && (
                <button
                  type="button"
                  onClick={navigateUp}
                  className="file-browser-entry"
                >
                  ..
                </button>
              )}
              {entries.map((entry) => (
                <button
                  type="button"
                  key={entry.name}
                  onClick={() => {
                    if (entry.type === "directory") navigateTo(entry.name);
                  }}
                  disabled={entry.type !== "directory"}
                  className="file-browser-entry"
                >
                  <span className="file-browser-entry-icon" aria-hidden="true">
                    {entry.type === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}
                  </span>
                  {entry.name}
                </button>
              ))}
              {entries.length === 0 && !loading && (
                <div className="file-browser-empty">
                  Empty directory
                </div>
              )}
            </>
          )}
        </div>

        {multiSelect && selected.length > 0 && (
          <div
            data-testid="file-browser-selection"
            className="file-browser-selection"
          >
            {selected.map((path) => (
              <span key={path} className="file-browser-selection-chip">
                <span
                  className="file-browser-selection-path"
                  title={path}
                >
                  {path}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${path} from selection`}
                  onClick={() => handleRemoveFromSelection(path)}
                  className="file-browser-selection-remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="file-browser-footer">
          <span
            className={`file-browser-detection${hasZarrJson ? " detected" : ""}`}
          >
            {hasZarrJson ? "Zarr dataset detected" : "Navigate to a .zarr directory"}
          </span>
          <div className="file-browser-actions">
            <button
              type="button"
              onClick={onClose}
              className="file-browser-action"
            >
              Cancel
            </button>
            {multiSelect && (
              <button
                type="button"
                onClick={handleAddToSelection}
                disabled={!hasZarrJson || alreadySelected}
                className="file-browser-action"
              >
                {alreadySelected ? "Added" : "Add to selection"}
              </button>
            )}
            {onSelect && (
              <button
                type="button"
                onClick={handleOpen}
                disabled={!hasZarrJson}
                className="file-browser-action primary"
              >
                Open
              </button>
            )}
            {multiSelect && (
              <button
                type="button"
                onClick={handleCreateWorkspace}
                disabled={selected.length === 0 && !hasZarrJson}
                className="file-browser-action primary"
              >
                {selected.length > 1
                  ? `Create workspace (${selected.length})`
                  : "Create workspace from selection"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
