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
import { dismissToast, toast } from "../ui/toastQueue.ts";
import "./BookmarkSidebar.css";

// How long a rejected proposal lingers (hidden, undoable) before the reject
// PATCH actually fires. Long enough to read the toast and hit Undo; short
// enough that an editor curating a queue isn't left waiting.
const REJECT_UNDO_WINDOW_MS = 6000;

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
  /** Id of the saved view currently applied to the viewer; its row renders as
   *  active. */
  currentOpenSavedViewId?: string | null;
  /** Called when the open view stops existing through an action here: deleted,
   *  withdrawn, or its deferred reject commits. The host clears its active-row id
   *  so the highlight doesn't dangle. Viewport changes are cleared host-side. */
  onActiveSavedViewInvalidated?: (savedViewId: string) => void;
  style?: React.CSSProperties;
  visible: boolean;
}

function failed(title: string, e: unknown): void {
  toast({ title, description: e instanceof Error ? e.message : String(e), tone: "danger" });
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
  onActiveSavedViewInvalidated,
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

  // Only the creator, with edit access, may promote a personal view to shared.
  // The server enforces this; the UI just avoids offering an action that would
  // 403. Mirrors the hook's lowercase email comparison.
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
  // A viewer can't share directly, so they propose their own personal view for
  // an editor to approve. Editors share directly, so the two never overlap.
  const canProposeToTeam = useCallback(
    (view: WorkspaceSavedView): boolean =>
      !canEdit && view.visibility === "personal" && isMine(view),
    [canEdit, isMine],
  );
  // A proposer can withdraw their own pending proposal back to personal at any
  // time, whether or not they can edit.
  const canWithdrawProposal = useCallback(
    (view: WorkspaceSavedView): boolean =>
      view.visibility === "proposed" && isMine(view),
    [isMine],
  );

  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmRequest | null>(null);
  const [confirmPropose, setConfirmPropose] = useState<ConfirmRequest | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Ids whose Reject is in its cancelable window: hidden from the review queue
  // but not yet sent to the server.
  const [pendingReject, setPendingReject] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Mirrored into refs so handlers can report "the open view went away" without
  // taking these as deps, which would churn every callback identity when the
  // active row changes. Read at call time only, never during render, so the
  // react-hooks/refs render-write rule is disabled on the assignment lines.
  const currentOpenSavedViewIdRef = useRef(currentOpenSavedViewId);
  // eslint-disable-next-line react-hooks/refs
  currentOpenSavedViewIdRef.current = currentOpenSavedViewId;
  const onActiveSavedViewInvalidatedRef = useRef(onActiveSavedViewInvalidated);
  // eslint-disable-next-line react-hooks/refs
  onActiveSavedViewInvalidatedRef.current = onActiveSavedViewInvalidated;
  // If `id` is the active view, tell the host it's gone. Safe to call for any id.
  const invalidateIfOpen = useCallback((id: string) => {
    if (currentOpenSavedViewIdRef.current === id) {
      onActiveSavedViewInvalidatedRef.current?.(id);
    }
  }, []);

  // One timer and one Undo toast per deferred reject, so several can be undone
  // independently. Both go on unmount: a pending PATCH never fires after the
  // sidebar is gone, and an Undo with nothing left to undo never lingers.
  const rejectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const rejectToasts = useRef(new Map<string, string>());
  const closeRejectToast = useCallback((id: string) => {
    const toastId = rejectToasts.current.get(id);
    if (toastId === undefined) return;
    rejectToasts.current.delete(id);
    dismissToast(toastId);
  }, []);
  useEffect(() => {
    const rejects = rejectTimers.current;
    const undoToasts = rejectToasts.current;
    return () => {
      for (const timer of rejects.values()) clearTimeout(timer);
      rejects.clear();
      for (const toastId of undoToasts.values()) dismissToast(toastId);
      undoToasts.clear();
    };
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
        toast({ title: "No active view to save", tone: "warning" });
        return;
      }
      try {
        await createSavedView(name, view, visibility);
        toast({
          title:
            visibility === "personal"
              ? `Saved "${name}" to your personal views`
              : `Saved "${name}" for the team`,
          tone: "success",
        });
      } catch (e) {
        failed("Save failed", e);
      }
    },
    [createSavedView, getCurrentSavedView],
  );

  const handleOpen = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await onOpenSavedView(view.view, view.id);
      } catch (e) {
        failed("Open failed", e);
      }
    },
    [onOpenSavedView],
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
        failed("Rename failed", e);
      } finally {
        setRenameId(null);
      }
    },
    [renameSavedView],
  );

  const handleReplace = useCallback(
    async (view: WorkspaceSavedView) => {
      const current = getCurrentSavedView();
      if (!current) {
        toast({ title: "No active view to save", tone: "warning" });
        return;
      }
      try {
        await replaceSavedView(view.id, current);
        toast({ title: `Updated "${view.name}"`, tone: "success" });
      } catch (e) {
        failed("Update failed", e);
      }
    },
    [getCurrentSavedView, replaceSavedView],
  );

  const handlePromote = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "shared");
        toast({ title: `Shared "${view.name}" with the team`, tone: "success" });
      } catch (e) {
        failed("Share failed", e);
      }
    },
    [setSavedViewVisibility],
  );

  // Runs from the confirm modal, never directly from the menu.
  const handlePropose = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "proposed");
        toast({ title: `Proposed "${view.name}" to the team for review`, tone: "success" });
      } catch (e) {
        failed("Propose failed", e);
      } finally {
        setConfirmPropose(null);
      }
    },
    [setSavedViewVisibility],
  );

  const handleWithdraw = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "personal");
        invalidateIfOpen(view.id);
        toast({ title: `Withdrew "${view.name}"`, description: "It is back in your personal views." });
      } catch (e) {
        failed("Withdraw failed", e);
      }
    },
    [invalidateIfOpen, setSavedViewVisibility],
  );

  const handleApprove = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await approveSavedView(view.id);
        toast({ title: `Approved "${view.name}"`, description: "It is now shared with the team.", tone: "success" });
      } catch (e) {
        failed("Approve failed", e);
      }
    },
    [approveSavedView],
  );

  // Cancel a pending reject before it commits. The row was only hidden locally,
  // so no PATCH is ever sent. Other views' Undo toasts stay.
  const cancelReject = useCallback(
    (id: string) => {
      const timer = rejectTimers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        rejectTimers.current.delete(id);
      }
      setPendingReject((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      closeRejectToast(id);
    },
    [closeRejectToast],
  );

  // Reject is a delayed, cancelable send: hide the row now, offer Undo, and fire
  // the PATCH once the window elapses. Approve stays immediate.
  const handleReject = useCallback(
    (view: WorkspaceSavedView) => {
      const id = view.id;
      // Coalesce a re-click on an already-pending row: keep the existing timer.
      if (rejectTimers.current.has(id)) return;

      setPendingReject((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });

      const timer = setTimeout(() => {
        rejectTimers.current.delete(id);
        // A hovered or focused toast holds its own timer, so close it here,
        // where the Undo stops meaning anything.
        closeRejectToast(id);
        // Clear the local hide once it settles; on failure the hook's refresh
        // restores the row.
        void rejectSavedView(id)
          .then(() => {
            // Only here, not at click time: the view stays active through the
            // whole cancelable window.
            invalidateIfOpen(id);
          })
          .catch((e) => {
            failed("Reject failed", e);
          })
          .finally(() => {
            setPendingReject((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          });
      }, REJECT_UNDO_WINDOW_MS);
      rejectTimers.current.set(id, timer);

      // The Undo toast lives for the whole cancelable window.
      rejectToasts.current.set(
        id,
        toast({
          title: `Rejected "${view.name}"`,
          action: { label: "Undo", onPress: () => cancelReject(id) },
          timeout: REJECT_UNDO_WINDOW_MS,
        }),
      );
    },
    [cancelReject, closeRejectToast, invalidateIfOpen, rejectSavedView],
  );

  const handleSetDefault = useCallback(
    async (view: WorkspaceSavedView) => {
      const nextDefaultId = defaultSavedViewId === view.id ? null : view.id;
      try {
        await onSetDefaultSavedView(nextDefaultId);
        toast({
          title: nextDefaultId === null ? "Default view cleared" : `"${view.name}" set as default`,
          tone: "success",
        });
      } catch (e) {
        failed("Default update failed", e);
      }
    },
    [defaultSavedViewId, onSetDefaultSavedView],
  );

  const handleDelete = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await deleteSavedView(view.id);
        invalidateIfOpen(view.id);
        if (defaultSavedViewId === view.id) {
          await onSetDefaultSavedView(null).catch((e) => {
            console.warn("[WorkspaceSavedViewsSidebar] default clear after delete failed:", e);
          });
        }
        toast({ title: `Deleted "${view.name}"` });
      } catch (e) {
        failed("Delete failed", e);
      } finally {
        setConfirmDelete(null);
      }
    },
    [defaultSavedViewId, deleteSavedView, invalidateIfOpen, onSetDefaultSavedView],
  );

  const handleCopyLink = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}#b=${encodeURIComponent(view.id)}`;
        await navigator.clipboard.writeText(url);
        toast({ title: "View link copied", tone: "success" });
      } catch (e) {
        failed("Copy failed", e);
      }
    },
    [],
  );

  // Called when the Save dialog opens (the modal seeds its state once), so the
  // suggested name reflects the position at the moment of saving.
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

  // Editors get a review queue holding every pending proposal, with Approve and
  // Reject. Viewers have none: their own proposals stay inline with a "Proposed"
  // chip. A row mid-reject is hidden from the queue before its PATCH is sent;
  // Undo brings it back because it never left the data.
  const reviewQueue = canEdit
    ? savedViews.filter(
        (view) => view.visibility === "proposed" && !pendingReject.has(view.id),
      )
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
                      handleReject(view);
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
            // Rename/Delete of your own view, except a shared one: those are
            // editor-only, and the server enforces it.
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
          canWithdraw={(() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            return view ? canWithdrawProposal(view) : false;
          })()}
          onPromote={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handlePromote(view);
          }}
          onPropose={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            // Confirm first: proposing makes the view visible to every editor.
            if (view) setConfirmPropose({ savedView: view });
          }}
          onWithdraw={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            setMenu(null);
            if (view) void handleWithdraw(view);
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
        <ConfirmModal
          ariaLabel="Confirm delete"
          tone="danger"
          title="Delete saved view?"
          confirmLabel="Delete"
          body={
            <>
              Delete saved view <strong>"{confirmDelete.savedView.name}"</strong>?
              {" "}This cannot be undone.
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.savedView)}
        />
      )}

      {confirmPropose && (
        <ConfirmModal
          ariaLabel="Confirm propose"
          tone="primary"
          title="Propose to the team?"
          confirmLabel="Propose to team"
          confirmTestId="saved-view-propose-confirm"
          body={
            <>
              Propose <strong>"{confirmPropose.savedView.name}"</strong> to the
              team? Every editor will see it in their review queue and can approve
              it to share it with the whole workspace.
            </>
          }
          onCancel={() => setConfirmPropose(null)}
          onConfirm={() => void handlePropose(confirmPropose.savedView)}
        />
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
  canWithdraw,
  onPromote,
  onPropose,
  onWithdraw,
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
  canWithdraw: boolean;
  onPromote: () => void;
  onPropose: () => void;
  onWithdraw: () => void;
  onRename: () => void;
  onSetDefault: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onCopyLink: () => void;
}) {
  // The server lets a creator rename or delete their own view, so offer it even
  // to a viewer. Set-default, Update, and promote act on the shared document and
  // stay gated by edit access.
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
      {canWithdraw && (
        <button
          type="button"
          role="menuitem"
          data-testid={`saved-view-withdraw-${savedViewId}`}
          onClick={onWithdraw}
        >
          Withdraw proposal
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
  // Personal is the default for everyone, so sharing stays a deliberate choice.
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
          <span className="bookmark-save-tile-label">Name</span>
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
          <legend className="bookmark-save-tile-label">Who can see this</legend>
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

// One confirm modal for irreversible or broadcasting actions (delete, propose).
// `tone` only swaps the confirm button's accent: danger for destructive actions,
// primary for deliberate ones like proposing.
function ConfirmModal({
  ariaLabel,
  title,
  body,
  confirmLabel,
  tone,
  confirmTestId,
  onCancel,
  onConfirm,
}: {
  ariaLabel: string;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  tone: "danger" | "primary";
  confirmTestId?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="bookmark-confirm-overlay" onClick={onCancel}>
      <div
        className={`bookmark-confirm-modal bookmark-confirm-modal-${tone}`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label={ariaLabel}
      >
        <h4>{title}</h4>
        <p>{body}</p>
        <div className="bookmark-confirm-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={tone}
            data-testid={confirmTestId}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
