import {
  useCallback,
  useEffect,
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
  onOpenSavedView: (view: SavedView, savedViewId: string) => void | Promise<void>;
  loadedDatasetNames: readonly string[];
  activeLayoutName?: string | null;
  defaultSavedViewId: string | null;
  onSetDefaultSavedView: (savedViewId: string | null) => Promise<void>;
  /** Id of the saved view currently applied to the viewer, if any. The matching
   *  row renders as active so the user can see which view they're looking at. */
  currentOpenSavedViewId?: string | null;
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
  currentOpenSavedViewId,
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
    setSavedViewVisibility,
    approveSavedView,
    rejectSavedView,
    deleteSavedView,
  } = useWorkspaceSavedViews({
    workspaceId,
    currentUserEmail,
  });

  // A personal view may be promoted to shared only by the member who created
  // it, and only when they have edit access (the server enforces all three;
  // the UI just avoids offering an action that would 403). Mirrors the
  // hook's "mine only" lowercase email comparison.
  const normalizedCurrentUserEmail = currentUserEmail?.toLowerCase() ?? null;
  const isMine = useCallback(
    (view: WorkspaceSavedView): boolean =>
      normalizedCurrentUserEmail !== null &&
      view.created_by.toLowerCase() === normalizedCurrentUserEmail,
    [normalizedCurrentUserEmail],
  );
  const canPromoteToShared = useCallback(
    (view: WorkspaceSavedView): boolean =>
      canEdit && view.visibility === "personal" && isMine(view),
    [canEdit, isMine],
  );
  // A viewer (no edit access) can't share directly, so they instead *propose*
  // their own personal view to the team for an editor to approve (#702). An
  // editor uses the direct "Share with team" action above, so the two never
  // overlap.
  const canProposeToTeam = useCallback(
    (view: WorkspaceSavedView): boolean =>
      !canEdit && view.visibility === "personal" && isMine(view),
    [canEdit, isMine],
  );

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
        await onOpenSavedView(view.view, view.id);
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

  const handlePromote = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "shared");
        showToast(`Shared "${view.name}" with the team`);
      } catch (e) {
        showToast(`Share failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [setSavedViewVisibility, showToast],
  );

  const handlePropose = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "proposed");
        showToast(`Proposed "${view.name}" to the team for review`);
      } catch (e) {
        showToast(`Propose failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [setSavedViewVisibility, showToast],
  );

  const handleApprove = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await approveSavedView(view.id);
        showToast(`Approved "${view.name}" — now shared with the team`);
      } catch (e) {
        showToast(`Approve failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [approveSavedView, showToast],
  );

  const handleReject = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await rejectSavedView(view.id);
        showToast(`Rejected "${view.name}" — returned to the proposer`);
      } catch (e) {
        showToast(`Reject failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [rejectSavedView, showToast],
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

  // Built fresh when the Save dialog opens (the modal seeds its own state once
  // from this prop) so the suggested name reflects the position — Z plane, and
  // T/C when non-default — at the moment of saving.
  const makeDefaultName = useCallback(
    () =>
      defaultWorkspaceSavedViewName(
        loadedDatasetNames,
        activeLayoutName ?? null,
        getCurrentSavedView()?.view,
      ),
    [loadedDatasetNames, activeLayoutName, getCurrentSavedView],
  );

  if (!visible) return null;

  const showEmptyState = !isLoading && savedViews.length === 0;
  const emptyText = pickEmptyMessage({
    canEdit,
    filterActive: filter.search.trim().length > 0 || filter.mineOnly,
  });

  // Editors get a dedicated review queue: every pending proposal the server
  // surfaced to them (their own + every other member's) is pulled out of the
  // main list into its own section with Approve / Reject. For a plain viewer
  // there is no review queue — their own proposals just stay inline with a
  // "Proposed" chip so they can see the pending status. Keeping the partition
  // local means shared/personal rows render exactly as before.
  const reviewQueue = canEdit
    ? savedViews.filter((view) => view.visibility === "proposed")
    : [];
  const mainList = canEdit
    ? savedViews.filter((view) => view.visibility !== "proposed")
    : savedViews;

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

      {reviewQueue.length > 0 && (
        <div className="bookmark-review-section" data-testid="saved-view-review-queue">
          <div className="bookmark-section-header">
            Proposed for review ({reviewQueue.length})
          </div>
          <div className="bookmark-list" role="list">
            {reviewQueue.map((view) => (
              <SavedViewRow
                key={view.id}
                view={view}
                isRenaming={renameId === view.id}
                isDefault={defaultSavedViewId === view.id}
                isActive={currentOpenSavedViewId === view.id}
                onRenameCommit={(n) => handleRenameCommit(view.id, n)}
                onRenameCancel={() => setRenameId(null)}
                onOpen={() => void handleOpen(view)}
                onMenu={(rect) =>
                  setMenu({ savedViewId: view.id, x: rect.right, y: rect.bottom })}
              >
                <div className="bookmark-review-actions">
                  <button
                    type="button"
                    className="primary"
                    data-testid={`saved-view-approve-${view.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleApprove(view);
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="danger"
                    data-testid={`saved-view-reject-${view.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleReject(view);
                    }}
                  >
                    Reject
                  </button>
                </div>
              </SavedViewRow>
            ))}
          </div>
        </div>
      )}

      <div className="bookmark-list" role="list">
        {mainList.map((view) => (
          <SavedViewRow
            key={view.id}
            view={view}
            isRenaming={renameId === view.id}
            isDefault={defaultSavedViewId === view.id}
            isActive={currentOpenSavedViewId === view.id}
            onRenameCommit={(n) => handleRenameCommit(view.id, n)}
            onRenameCancel={() => setRenameId(null)}
            onOpen={() => void handleOpen(view)}
            onMenu={(rect) =>
              setMenu({ savedViewId: view.id, x: rect.right, y: rect.bottom })}
          />
        ))}
        {showEmptyState && <div className="bookmark-empty">{emptyText}</div>}
      </div>

      {menu && (
        <WorkspaceSavedViewActionsMenu
          x={menu.x}
          y={menu.y}
          canEdit={canEdit}
          isMine={(() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            // Own-management (Rename/Delete) is scoped to a creator's own
            // personal/proposed view — a shared view is editor-only (the server
            // enforces this), so don't offer it for an own *shared* view.
            return view ? isMine(view) && view.visibility !== "shared" : false;
          })()}
          isDefault={defaultSavedViewId === menu.savedViewId}
          savedViewId={menu.savedViewId}
          canPromote={(() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            return view ? canPromoteToShared(view) : false;
          })()}
          canPropose={(() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            return view ? canProposeToTeam(view) : false;
          })()}
          onPromote={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handlePromote(view);
          }}
          onPropose={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handlePropose(view);
          }}
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
          defaultName={makeDefaultName()}
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

const VISIBILITY_CHIP: Record<
  WorkspaceSavedView["visibility"],
  { label: string; title: string } | null
> = {
  shared: { label: "Shared", title: "Shared with the whole team" },
  personal: { label: "Personal", title: "Only you can see this saved view" },
  proposed: {
    label: "Proposed",
    title: "Pending: proposed to the team, awaiting an editor's review",
  },
};

function SavedViewRow({
  view,
  isRenaming,
  isDefault,
  isActive,
  onRenameCommit,
  onRenameCancel,
  onOpen,
  onMenu,
  children,
}: {
  view: WorkspaceSavedView;
  isRenaming: boolean;
  isDefault: boolean;
  isActive: boolean;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onOpen: () => void;
  onMenu: (rect: DOMRect) => void;
  children?: React.ReactNode;
}) {
  const chip = VISIBILITY_CHIP[view.visibility];
  return (
    <div
      role="listitem"
      className="bookmark-row"
      data-testid="saved-view-row"
      data-visibility={view.visibility}
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
      onClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".bookmark-menu-btn")) return;
        if (target?.closest(".bookmark-name-input")) return;
        if (target?.closest(".bookmark-review-actions")) return;
        if (isRenaming) return;
        onOpen();
      }}
    >
      <div className="bookmark-row-top">
        {isRenaming ? (
          <RenameInput
            initial={view.name}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="bookmark-name" title={view.name}>{view.name}</span>
        )}
        {chip && (
          <span
            className={`bookmark-visibility-chip bookmark-visibility-chip-${view.visibility}`}
            data-testid={`saved-view-visibility-${view.id}`}
            title={chip.title}
          >
            {chip.label}
          </span>
        )}
        <button
          type="button"
          className="bookmark-menu-btn"
          aria-label="Saved view actions"
          onClick={(e) => {
            e.stopPropagation();
            onMenu((e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        >
          ...
        </button>
      </div>
      <div className="bookmark-row-meta">
        {view.created_by_name || view.created_by} | {relativeTimeFromIso(view.updated_at)}
        {isDefault ? " | default" : ""}
      </div>
      {children}
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
  isMine,
  isDefault,
  savedViewId,
  canPromote,
  canPropose,
  onPromote,
  onPropose,
  onRename,
  onSetDefault,
  onReplace,
  onDelete,
  onCopyLink,
}: {
  x: number;
  y: number;
  canEdit: boolean;
  isMine: boolean;
  isDefault: boolean;
  savedViewId: string;
  canPromote: boolean;
  canPropose: boolean;
  onPromote: () => void;
  onPropose: () => void;
  onRename: () => void;
  onSetDefault: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onCopyLink: () => void;
}) {
  // Renaming/deleting a row you created is a personal action the server already
  // permits its creator (workspace_personal_saved_view_mutations_are_creator_only),
  // so offer it whenever the row is mine — even to a viewer. Set-default /
  // Update / promote act on the shared document and stay gated by edit access.
  const canManageOwn = canEdit || isMine;
  return (
    <div
      className="bookmark-menu"
      style={{ left: x - 180, top: y + 4 }}
      role="menu"
    >
      <button type="button" role="menuitem" onClick={onCopyLink}>Copy view link</button>
      {canPromote && (
        <button
          type="button"
          role="menuitem"
          data-testid={`saved-view-promote-${savedViewId}`}
          onClick={onPromote}
        >
          Share with team
        </button>
      )}
      {canPropose && (
        <button
          type="button"
          role="menuitem"
          data-testid={`saved-view-propose-${savedViewId}`}
          onClick={onPropose}
        >
          Propose to team
        </button>
      )}
      {canEdit && (
        <>
          <button type="button" role="menuitem" onClick={onSetDefault}>
            {isDefault ? "Clear default" : "Set as default"}
          </button>
          <button type="button" role="menuitem" onClick={onReplace}>Update from current view</button>
        </>
      )}
      {canManageOwn && (
        <>
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
  // Personal is the default for everyone — sharing stays a deliberate one-click
  // choice. Viewers can only save personally, so for them it's also the only
  // enabled option.
  const [visibility, setVisibility] = useState<WorkspaceSavedViewVisibility>(
    "personal",
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
