import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { relativeTimeFromIso } from "../savedView/useBookmarks.ts";
import {
  defaultWorkspaceSavedViewName,
  useWorkspaceSavedViews,
  type WorkspaceSavedView,
  type WorkspaceSavedViewVisibility,
} from "../savedView/useWorkspaceSavedViews.ts";
import type { SavedView } from "../savedView/types.ts";
import "./BookmarkSidebar.css";

export interface WorkspaceSavedViewsSidebarProps {
  workspaceId: string;
  currentUserEmail: string | null;
  canEdit: boolean;
  getCurrentSavedView: () => SavedView | null;
  onOpenSavedView: (view: SavedView) => void | Promise<void>;
  loadedDatasetNames: readonly string[];
  activeLayoutName?: string | null;
  defaultSavedViewId: string | null;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
  style?: React.CSSProperties;
  visible: boolean;
}

interface ToastMessage {
  text: string;
  kind: "info" | "warn";
}

interface ConfirmRequest {
  savedView: WorkspaceSavedView;
}

interface MenuState {
  savedViewId: string;
  x: number;
  y: number;
}

export function WorkspaceSavedViewsSidebar({
  workspaceId,
  currentUserEmail,
  canEdit,
  getCurrentSavedView,
  onOpenSavedView,
  loadedDatasetNames,
  activeLayoutName,
  defaultSavedViewId,
  onSetDefaultSavedView,
  style,
  visible,
}: WorkspaceSavedViewsSidebarProps) {
  const {
    savedViews,
    isLoading,
    error,
    filter,
    setSearch,
    setMineOnly,
    createSavedView,
    renameSavedView,
    replaceSavedView,
    deleteSavedView,
  } = useWorkspaceSavedViews({
    workspaceId,
    currentUserEmail,
  });

  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmRequest | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const dismissToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string, kind: ToastMessage["kind"] = "info") => {
    setToast({ text, kind });
    if (dismissToastTimer.current) clearTimeout(dismissToastTimer.current);
    dismissToastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".bookmark-menu")) return;
      if (target?.closest(".bookmark-menu-btn")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleSave = useCallback(
    async (name: string, visibility: WorkspaceSavedViewVisibility) => {
      const view = getCurrentSavedView();
      if (!view) {
        showToast("No active view to save", "warn");
        return;
      }
      try {
        await createSavedView(name, view, visibility);
        showToast(
          visibility === "personal"
            ? `Saved "${name}" to your personal views`
            : `Saved "${name}" for the team`,
        );
      } catch (e) {
        showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [createSavedView, getCurrentSavedView, showToast],
  );

  const handleOpen = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await onOpenSavedView(view.view);
      } catch (e) {
        showToast(`Open failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [onOpenSavedView, showToast],
  );

  const handleRenameCommit = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setRenameId(null);
        return;
      }
      try {
        await renameSavedView(id, trimmed);
      } catch (e) {
        showToast(`Rename failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      } finally {
        setRenameId(null);
      }
    },
    [renameSavedView, showToast],
  );

  const handleReplace = useCallback(
    async (view: WorkspaceSavedView) => {
      const current = getCurrentSavedView();
      if (!current) {
        showToast("No active view to save", "warn");
        return;
      }
      try {
        await replaceSavedView(view.id, current);
        showToast(`Updated "${view.name}"`);
      } catch (e) {
        showToast(`Update failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [getCurrentSavedView, replaceSavedView, showToast],
  );

  const handleSetDefault = useCallback(
    async (view: WorkspaceSavedView) => {
      const nextDefaultId = defaultSavedViewId === view.id ? null : view.id;
      try {
        await onSetDefaultSavedView(nextDefaultId);
        showToast(nextDefaultId === null ? "Default view cleared" : `"${view.name}" set as default`);
      } catch (e) {
        showToast(`Default update failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [defaultSavedViewId, onSetDefaultSavedView, showToast],
  );

  const handleDelete = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await deleteSavedView(view.id);
        if (defaultSavedViewId === view.id) {
          await onSetDefaultSavedView(null).catch((e) => {
            console.warn("[WorkspaceSavedViewsSidebar] default clear after delete failed:", e);
          });
        }
        showToast(`Deleted "${view.name}"`);
      } catch (e) {
        showToast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      } finally {
        setConfirmDelete(null);
      }
    },
    [defaultSavedViewId, deleteSavedView, onSetDefaultSavedView, showToast],
  );

  const handleCopyLink = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}#b=${encodeURIComponent(view.id)}`;
        await navigator.clipboard.writeText(url);
        showToast("View link copied");
      } catch (e) {
        showToast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [showToast],
  );

  const defaultName = useMemo(
    () => defaultWorkspaceSavedViewName(loadedDatasetNames, activeLayoutName ?? null),
    [loadedDatasetNames, activeLayoutName],
  );

  if (!visible) return null;

  const showEmptyState = !isLoading && savedViews.length === 0;
  const emptyText = pickEmptyMessage({
    canEdit,
    filterActive: filter.search.trim().length > 0 || filter.mineOnly,
  });

  return (
    <div className="bookmark-sidebar" style={style}>
      <div className="bookmark-sidebar-header">
        <h3>Saved Views</h3>
        <button
          type="button"
          className="primary"
          onClick={() => setSavePromptOpen(true)}
          title={
            canEdit
              ? "Save the current workspace view"
              : "Save the current view to your personal views"
          }
        >
          Save view
        </button>
      </div>

      <div className="bookmark-filter-row">
        <input
          type="text"
          className="bookmark-search"
          placeholder="Search name or creator..."
          value={filter.search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="bookmark-mine-toggle">
          <input
            type="checkbox"
            checked={filter.mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />
          Mine only
        </label>
      </div>

      {error && <div className="bookmark-error">Error: {error}</div>}
      {isLoading && <div className="bookmark-loading">Loading saved views...</div>}

      <div className="bookmark-list" role="list">
        {savedViews.map((view) => (
          <div
            key={view.id}
            role="listitem"
            className="bookmark-row"
            data-testid="saved-view-row"
            data-visibility={view.visibility}
            onClick={(e) => {
              const target = e.target as HTMLElement | null;
              if (target?.closest(".bookmark-menu-btn")) return;
              if (target?.closest(".bookmark-name-input")) return;
              if (renameId === view.id) return;
              void handleOpen(view);
            }}
          >
            <div className="bookmark-row-top">
              {renameId === view.id ? (
                <RenameInput
                  initial={view.name}
                  onCommit={(n) => handleRenameCommit(view.id, n)}
                  onCancel={() => setRenameId(null)}
                />
              ) : (
                <span className="bookmark-name" title={view.name}>{view.name}</span>
              )}
              {view.visibility === "personal" && (
                <span
                  className="bookmark-visibility-chip"
                  title="Only you can see this saved view"
                >
                  Personal
                </span>
              )}
              <button
                type="button"
                className="bookmark-menu-btn"
                aria-label="Saved view actions"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ savedViewId: view.id, x: rect.right, y: rect.bottom });
                }}
              >
                ...
              </button>
            </div>
            <div className="bookmark-row-meta">
              {view.created_by_name || view.created_by} | {relativeTimeFromIso(view.updated_at)}
              {defaultSavedViewId === view.id ? " | default" : ""}
            </div>
          </div>
        ))}
        {showEmptyState && <div className="bookmark-empty">{emptyText}</div>}
      </div>

      {menu && (
        <WorkspaceSavedViewActionsMenu
          x={menu.x}
          y={menu.y}
          canEdit={canEdit}
          isDefault={defaultSavedViewId === menu.savedViewId}
          onRename={() => {
            setRenameId(menu.savedViewId);
            setMenu(null);
          }}
          onSetDefault={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handleSetDefault(view);
          }}
          onReplace={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handleReplace(view);
          }}
          onDelete={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) setConfirmDelete({ savedView: view });
          }}
          onCopyLink={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handleCopyLink(view);
          }}
        />
      )}

      {savePromptOpen && (
        <SaveWorkspaceSavedViewModal
          defaultName={defaultName}
          canSaveShared={canEdit}
          onCancel={() => setSavePromptOpen(false)}
          onSave={async (name, visibility) => {
            setSavePromptOpen(false);
            await handleSave(name, visibility);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          name={confirmDelete.savedView.name}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.savedView)}
        />
      )}

      {toast && (
        <div
          role="status"
          className={`bookmark-toast${toast.kind === "warn" ? " warn" : ""}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function pickEmptyMessage({
  canEdit,
  filterActive,
}: {
  canEdit: boolean;
  filterActive: boolean;
}): string {
  if (filterActive) return "No saved views match the current filter.";
  if (canEdit) return "No saved views yet. Save the current view to get started.";
  return "No saved views yet.";
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="bookmark-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function WorkspaceSavedViewActionsMenu({
  x,
  y,
  canEdit,
  isDefault,
  onRename,
  onSetDefault,
  onReplace,
  onDelete,
  onCopyLink,
}: {
  x: number;
  y: number;
  canEdit: boolean;
  isDefault: boolean;
  onRename: () => void;
  onSetDefault: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onCopyLink: () => void;
}) {
  return (
    <div
      className="bookmark-menu"
      style={{ left: x - 180, top: y + 4 }}
      role="menu"
    >
      <button type="button" role="menuitem" onClick={onCopyLink}>Copy view link</button>
      {canEdit && (
        <>
          <button type="button" role="menuitem" onClick={onSetDefault}>
            {isDefault ? "Clear default" : "Set as default"}
          </button>
          <button type="button" role="menuitem" onClick={onReplace}>Update from current view</button>
          <button type="button" role="menuitem" onClick={onRename}>Rename</button>
          <button type="button" role="menuitem" className="danger" onClick={onDelete}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function SaveWorkspaceSavedViewModal({
  defaultName,
  canSaveShared,
  onCancel,
  onSave,
}: {
  defaultName: string;
  canSaveShared: boolean;
  onCancel: () => void;
  onSave: (
    name: string,
    visibility: WorkspaceSavedViewVisibility,
  ) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  // Editors keep today's "shared" default; viewers can only save personally,
  // so personal is both the default and the only enabled choice.
  const [visibility, setVisibility] = useState<WorkspaceSavedViewVisibility>(
    canSaveShared ? "shared" : "personal",
  );
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const trimmed = name.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    onSave(trimmed, visibility);
  };

  return (
    <div className="bookmark-save-overlay" onClick={onCancel}>
      <div
        className="bookmark-save-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Save current view"
      >
        <h4>Save current view</h4>
        <label className="bookmark-save-field">
          <span className="bookmark-save-field-label">Name</span>
          <input
            ref={ref}
            type="text"
            data-testid="saved-view-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </label>

        <fieldset className="bookmark-visibility-fieldset">
          <legend className="bookmark-save-field-label">Who can see this</legend>
          <div className="bookmark-visibility-options" role="radiogroup" aria-label="Who can see this view">
            <label
              className={`bookmark-visibility-option${
                visibility === "personal" ? " selected" : ""
              }`}
            >
              <input
                type="radio"
                name="saved-view-visibility"
                data-testid="visibility-personal"
                value="personal"
                checked={visibility === "personal"}
                onChange={() => setVisibility("personal")}
              />
              <span className="bookmark-visibility-option-text">
                <span className="bookmark-visibility-option-title">Personal (only me)</span>
                <span className="bookmark-visibility-option-hint">
                  Saved to your account; teammates won't see it.
                </span>
              </span>
            </label>

            <label
              className={`bookmark-visibility-option${
                visibility === "shared" ? " selected" : ""
              }${canSaveShared ? "" : " disabled"}`}
            >
              <input
                type="radio"
                name="saved-view-visibility"
                data-testid="visibility-shared"
                value="shared"
                checked={visibility === "shared"}
                disabled={!canSaveShared}
                onChange={() => setVisibility("shared")}
              />
              <span className="bookmark-visibility-option-text">
                <span className="bookmark-visibility-option-title">Shared (team)</span>
                <span className="bookmark-visibility-option-hint">
                  {canSaveShared
                    ? "Everyone in this workspace can open it."
                    : "Needs edit access — viewers can only save personal views."}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="bookmark-save-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            data-testid="saved-view-save-confirm"
            disabled={trimmed.length === 0}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="bookmark-confirm-overlay" onClick={onCancel}>
      <div
        className="bookmark-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Confirm delete"
      >
        <h4>Delete saved view?</h4>
        <p>
          Delete saved view <strong>"{name}"</strong>? This cannot be undone.
        </p>
        <div className="bookmark-confirm-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
