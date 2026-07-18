import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { relativeTimeFromIso } from "../savedView/relativeTime.ts";
import {
  defaultWorkspaceSavedViewName,
  useWorkspaceSavedViews,
  type WorkspaceSavedView,
  type WorkspaceSavedViewVisibility,
} from "../savedView/useWorkspaceSavedViews.ts";
import type { SavedView } from "../savedView/types.ts";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { FloatingPortalSurface } from "./FloatingSurface.tsx";
import { InlineRenameInput } from "./InlineRenameInput.tsx";
import "./SavedViewSidebar.css";

// How long a rejected proposal lingers (hidden, cancelable) before the reject
// PATCH actually fires. Long enough to read the toast and cancel; short
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
  /** Id of the saved view currently applied to the viewer, if any. The matching
   *  row renders as active so the user can see which view they're looking at. */
  currentOpenSavedViewId?: string | null;
  /** Called when the saved view that is currently open (`currentOpenSavedViewId`)
   *  stops existing as the user acts on it — deleted, withdrawn, or its deferred
   *  reject commits. The host clears its active-row id so the highlight doesn't
   *  dangle on a view that's gone (#818). Viewport changes are cleared host-side
   *  off the live-view signal; this covers the "the open view went away" case. */
  onActiveSavedViewInvalidated?: (savedViewId: string) => void;
  style?: React.CSSProperties;
  visible: boolean;
}

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  /** Stable identity for this toast. Plain status toasts get an auto-generated
   *  id; a cancellation toast for a deferred reject is keyed by `reject:<savedViewId>`
   *  so each pending reject owns its OWN dismissible toast (the data layer
   *  already supports independent multi-undo via the per-id timer Map — the
   *  toast stack is the matching presentation). */
  id: string;
  text: string;
  kind: "info" | "warn";
  /** Optional inline action rendered as a button in the toast. */
  action?: ToastAction;
}

/** Stable toast id for a deferred reject so its cancellation toast never collides with
 *  (or gets clobbered by) another pending reject's toast. */
function rejectToastId(savedViewId: string): string {
  return `reject:${savedViewId}`;
}

interface ConfirmRequest {
  savedView: WorkspaceSavedView;
}

interface MenuState {
  savedViewId: string;
  anchorElement: HTMLElement;
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
  // The proposer can pull their own still-pending proposal back to private at
  // any time (the server permits a creator's Proposed -> Personal). Scoped to
  // the proposer's *own* proposed view — never another member's, never an
  // already-approved/shared one. Available whether or not they can edit.
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  // A STACK of toasts, not a single slot: rejecting view B must not evict view
  // A's still-live "Undo" toast while A's reject timer keeps running (#818).
  // Newest renders on top of the stack.
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  // Ids whose Reject is in its cancelable window: hidden from the review queue
  // optimistically, but NOT yet sent to the server (Undo can still cancel).
  const [pendingReject, setPendingReject] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // One auto-dismiss timer per toast id (toasts are now a stack, so a single
  // shared timer would let one toast's expiry tear down another's). Cleaned up
  // on unmount so no timer can setState after the sidebar is gone.
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seqRef = useRef(0);
  const dismissToast = useCallback((id: string) => {
    const timer = dismissTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.current.delete(id);
    }
    setToasts((prev) => {
      if (!prev.some((t) => t.id === id)) return prev;
      return prev.filter((t) => t.id !== id);
    });
  }, []);
  const showToast = useCallback(
    (
      text: string,
      kind: ToastMessage["kind"] = "info",
      opts?: { action?: ToastAction; durationMs?: number; id?: string },
    ) => {
      // Reject toasts pass a stable id (keyed by saved-view id) so re-issuing
      // replaces that view's own toast in place; status toasts get a fresh id
      // so each pushes onto the stack independently.
      const id = opts?.id ?? `toast:${seqRef.current++}`;
      const next: ToastMessage = { id, text, kind, action: opts?.action };
      setToasts((prev) => [...prev.filter((t) => t.id !== id), next]);
      const existing = dismissTimers.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        dismissTimers.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, opts?.durationMs ?? 3000);
      dismissTimers.current.set(id, timer);
    },
    [],
  );

  // Latest open-view id + invalidation callback, mirrored into refs so the
  // action handlers can fire "the open view went away" WITHOUT taking these as
  // deps (which would churn every callback identity each time the active row
  // changes). Read at call time only (from event handlers / settled async),
  // never during render — same latest-value-in-a-ref pattern as
  // useSavedViewSync.ts, so the react-hooks/refs render-write rule is disabled
  // on the assignment lines.
  const currentOpenSavedViewIdRef = useRef(currentOpenSavedViewId);
  // eslint-disable-next-line react-hooks/refs
  currentOpenSavedViewIdRef.current = currentOpenSavedViewId;
  const onActiveSavedViewInvalidatedRef = useRef(onActiveSavedViewInvalidated);
  // eslint-disable-next-line react-hooks/refs
  onActiveSavedViewInvalidatedRef.current = onActiveSavedViewInvalidated;
  // If `id` is the view currently flagged active, tell the host it's gone so the
  // stale highlight clears (#818). No-op otherwise, so it's always safe to call.
  const invalidateIfOpen = useCallback((id: string) => {
    if (currentOpenSavedViewIdRef.current === id) {
      onActiveSavedViewInvalidatedRef.current?.(id);
    }
  }, []);

  // One timer per deferred reject so a power-user can stack several at once and
  // Cancel each independently. Cleaned up on unmount so a pending PATCH never
  // fires after the sidebar is gone.
  const rejectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const rejects = rejectTimers.current;
    const dismisses = dismissTimers.current;
    return () => {
      for (const timer of rejects.values()) clearTimeout(timer);
      rejects.clear();
      // Also clear every toast auto-dismiss timer so none can setState after unmount.
      for (const timer of dismisses.values()) clearTimeout(timer);
      dismisses.clear();
    };
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".saved-view-menu")) return;
      if (target?.closest(".saved-view-menu-btn")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        menu.anchorElement.focus({ preventScroll: true });
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (menu === null) return;
    const closeIfDetached = () => {
      if (!menu.anchorElement.isConnected) {
        setMenu((current) => current === menu ? null : current);
      }
    };
    closeIfDetached();
    const observer = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(closeIfDetached);
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => observer?.disconnect();
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

  // Sending the proposal only happens after the confirm step (confirmPropose);
  // this is the actual PATCH the modal's confirm button triggers.
  const handlePropose = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "proposed");
        showToast(`Proposed "${view.name}" to the team for review`);
      } catch (e) {
        showToast(`Propose failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      } finally {
        setConfirmPropose(null);
      }
    },
    [setSavedViewVisibility, showToast],
  );

  // Withdraw: the proposer pulls their own pending proposal back to a private
  // personal view (the server allows a creator's Proposed -> Personal). Same
  // visibility PATCH the rest of the flow uses, so the chip/filters reconcile
  // off the server's canonical row.
  const handleWithdraw = useCallback(
    async (view: WorkspaceSavedView) => {
      try {
        await setSavedViewVisibility(view.id, "personal");
        // Withdrawing changes the view out from under the active-row claim, so
        // drop the highlight if this was the open view (#818).
        invalidateIfOpen(view.id);
        showToast(`Withdrew "${view.name}" — back to your personal views`);
      } catch (e) {
        showToast(`Withdraw failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [invalidateIfOpen, setSavedViewVisibility, showToast],
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

  // Cancel a pending reject before it commits: clear its timer, un-hide the
  // row (it was only hidden locally — never sent), and drop ONLY this view's
  // cancellation toast (others stay). No PATCH ever happens, so the rejection simply
  // never occurred.
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
      dismissToast(rejectToastId(id));
    },
    [dismissToast],
  );

  // Reject is a delayed, cancelable send: hide the row immediately and offer an
  // cancellation, but only fire the reject PATCH once the window elapses. Approve stays
  // immediate (see handleApprove) — only rejection is recoverable.
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
        // The window elapsed without cancellation: commit the rejection. The hook
        // drops it from the list and refreshes; clear our local hide once it
        // settles (on failure the refresh restores the row, so it reappears).
        void rejectSavedView(id)
          .then(() => {
            // The view is really gone now — if it was the open/active row, tell
            // the host so the highlight doesn't dangle (#818). Cancellation never
            // reaches here (it clears the timer first), so the live view is
            // still flagged active across the whole cancelable window.
            invalidateIfOpen(id);
          })
          .catch((e) => {
            showToast(
              `Reject failed: ${e instanceof Error ? e.message : String(e)}`,
              "warn",
            );
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

      // Keep the toast action alive for the whole cancelable window so
      // the affordance never vanishes while the reject can still be undone. The
      // toast is keyed by the saved-view id, so rejecting a second view pushes
      // its own cancellation toast onto the stack instead of evicting this one (#818).
      showToast(`Rejected "${view.name}"`, "info", {
        durationMs: REJECT_UNDO_WINDOW_MS,
        id: rejectToastId(id),
        action: { label: "Cancel rejection", onClick: () => cancelReject(id) },
      });
    },
    [cancelReject, invalidateIfOpen, rejectSavedView, showToast],
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
        // The view no longer exists — clear the active highlight if it was open (#818).
        invalidateIfOpen(view.id);
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
    [defaultSavedViewId, deleteSavedView, invalidateIfOpen, onSetDefaultSavedView, showToast],
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
  // A row whose Reject is mid-window is hidden from the queue right away (the
  // optimistic removal) even though its PATCH hasn't been sent yet; Undo brings
  // it straight back because it was never actually removed from the data.
  const reviewQueue = canEdit
    ? savedViews.filter(
        (view) => view.visibility === "proposed" && !pendingReject.has(view.id),
      )
    : [];
  const mainList = canEdit
    ? savedViews.filter((view) => view.visibility !== "proposed")
    : savedViews;

  const closeMenuAndRestoreFocus = (afterClose?: () => void) => {
    const trigger = menu?.anchorElement;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    setMenu(null);
    afterClose?.();
  };

  // A fully clipped row trigger is not a valid focus-restoration target. The
  // shared floating-surface owner reports that transition; close the menu state
  // (which clears aria-expanded/aria-controls) and move focus to the stable,
  // visible search field above the scrolling list.
  const closeMenuForHiddenAnchor = () => {
    setMenu(null);
    searchInputRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="saved-view-sidebar" data-floating-safe-region style={style}>
      <div className="saved-view-sidebar-header">
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

      <div className="saved-view-filter-row">
        <input
          ref={searchInputRef}
          type="text"
          aria-label="Search saved views"
          className="saved-view-search"
          placeholder="Search name or creator..."
          value={filter.search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="saved-view-mine-toggle">
          <input
            type="checkbox"
            checked={filter.mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />
          Mine only
        </label>
      </div>

      {error && <div className="saved-view-error" role="alert">Error: {error}</div>}
      {isLoading && (
        <div className="saved-view-loading" role="status" aria-live="polite">
          Loading saved views...
        </div>
      )}

      {reviewQueue.length > 0 && (
        <div className="saved-view-review-section" data-testid="saved-view-review-queue">
          <div className="saved-view-section-header">
            Proposed for review ({reviewQueue.length})
          </div>
          <div className="saved-view-list" role="list">
            {reviewQueue.map((view) => (
              <SavedViewRow
                key={view.id}
                view={view}
                isRenaming={renameId === view.id}
                isDefault={defaultSavedViewId === view.id}
                isActive={currentOpenSavedViewId === view.id}
                menuOpen={menu?.savedViewId === view.id}
                onRenameCommit={(n) => handleRenameCommit(view.id, n)}
                onRenameCancel={() => setRenameId(null)}
                onOpen={() => void handleOpen(view)}
                onMenu={(anchorElement) => setMenu((current) =>
                  current?.savedViewId === view.id
                    ? null
                    : { savedViewId: view.id, anchorElement })}
              >
                <div className="saved-view-review-actions">
                  {isMine(view) ? (
                    <span
                      className="saved-view-review-self-note"
                      data-testid={`saved-view-self-approval-note-${view.id}`}
                      role="note"
                    >
                      A different editor must approve your proposal.
                    </span>
                  ) : (
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
                  )}
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

      {showEmptyState ? (
        <div className="saved-view-empty">{emptyText}</div>
      ) : (
        <div className="saved-view-list" role="list">
          {mainList.map((view) => (
            <SavedViewRow
              key={view.id}
              view={view}
              isRenaming={renameId === view.id}
              isDefault={defaultSavedViewId === view.id}
              isActive={currentOpenSavedViewId === view.id}
              menuOpen={menu?.savedViewId === view.id}
              onRenameCommit={(n) => handleRenameCommit(view.id, n)}
              onRenameCancel={() => setRenameId(null)}
              onOpen={() => void handleOpen(view)}
              onMenu={(anchorElement) => setMenu((current) =>
                current?.savedViewId === view.id
                  ? null
                  : { savedViewId: view.id, anchorElement })}
            />
          ))}
        </div>
      )}

      {menu && (
        <WorkspaceSavedViewActionsMenu
          anchorElement={menu.anchorElement}
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
          onCloseAndRestoreFocus={() => closeMenuAndRestoreFocus()}
          onAnchorHidden={closeMenuForHiddenAnchor}
          hiddenAnchorFocusRef={searchInputRef}
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
            closeMenuAndRestoreFocus(() => {
              if (view) void handlePromote(view);
            });
          }}
          onPropose={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              // Confirm first — proposing makes the view visible to every editor.
              if (view) setConfirmPropose({ savedView: view });
            });
          }}
          onWithdraw={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              if (view) void handleWithdraw(view);
            });
          }}
          onRename={() => {
            closeMenuAndRestoreFocus(() => setRenameId(menu.savedViewId));
          }}
          onSetDefault={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              if (view) void handleSetDefault(view);
            });
          }}
          onReplace={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              if (view) void handleReplace(view);
            });
          }}
          onDelete={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              if (view) setConfirmDelete({ savedView: view });
            });
          }}
          onCopyLink={() => {
            const view = savedViews.find((item) => item.id === menu.savedViewId);
            closeMenuAndRestoreFocus(() => {
              if (view) void handleCopyLink(view);
            });
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

      {toasts.length > 0 && (
        <div className="saved-view-toast-stack" data-testid="saved-view-toast-stack">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={`saved-view-toast${t.kind === "warn" ? " warn" : ""}`}
              data-testid="saved-view-toast"
            >
              <span className="saved-view-toast-text">{t.text}</span>
              {t.action && (
                <button
                  type="button"
                  className="saved-view-toast-action"
                  data-testid="saved-view-toast-action"
                  onClick={t.action.onClick}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
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
  menuOpen,
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
  menuOpen: boolean;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onOpen: () => void;
  onMenu: (anchorElement: HTMLElement) => void;
  children?: React.ReactNode;
}) {
  const chip = VISIBILITY_CHIP[view.visibility];
  return (
    <div
      role="listitem"
      className="saved-view-row"
      data-testid="saved-view-row"
      data-visibility={view.visibility}
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
    >
      <div className="saved-view-row-top">
        {isRenaming ? (
          <InlineRenameInput
            initialValue={view.name}
            className="saved-view-name-input"
            aria-label="Saved view name"
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <button
            type="button"
            className="saved-view-name saved-view-open-button"
            title={view.name}
            onClick={onOpen}
          >
            {view.name}
          </button>
        )}
        {chip && (
          <span
            className={`saved-view-visibility-chip saved-view-visibility-chip-${view.visibility}`}
            data-testid={`saved-view-visibility-${view.id}`}
            title={chip.title}
          >
            {chip.label}
          </span>
        )}
        <button
          type="button"
          className="saved-view-menu-btn"
          aria-label="Saved view actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? `saved-view-actions-${view.id}` : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e.currentTarget);
          }}
        >
          ...
        </button>
      </div>
      <div className="saved-view-row-meta">
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

function WorkspaceSavedViewActionsMenu({
  anchorElement,
  canEdit,
  isMine,
  isDefault,
  savedViewId,
  onCloseAndRestoreFocus,
  onAnchorHidden,
  hiddenAnchorFocusRef,
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
  anchorElement: HTMLElement;
  canEdit: boolean;
  isMine: boolean;
  isDefault: boolean;
  savedViewId: string;
  onCloseAndRestoreFocus: () => void;
  onAnchorHidden: () => void;
  hiddenAnchorFocusRef: RefObject<HTMLElement | null>;
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
  // Renaming/deleting a row you created is a personal action the server already
  // permits its creator (workspace_personal_saved_view_mutations_are_creator_only),
  // so offer it whenever the row is mine — even to a viewer. Set-default /
  // Update / promote act on the shared document and stay gated by edit access.
  const canManageOwn = canEdit || isMine;
  const menuId = `saved-view-actions-${savedViewId}`;
  useLayoutEffect(() => {
    document.getElementById(menuId)
      ?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")
      ?.focus({ preventScroll: true });
  }, [menuId]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([disabled])",
      ),
    );
    if (items.length === 0) return;
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % items.length;
    if (event.key === "ArrowUp") {
      nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseAndRestoreFocus();
      return;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    }
  };
  return (
    <FloatingPortalSurface
      anchorElement={anchorElement}
      fallbackSize={{ width: 180, height: 320 }}
      onAnchorHidden={onAnchorHidden}
      focusFallbackRef={hiddenAnchorFocusRef}
      className="saved-view-menu"
      id={menuId}
      role="menu"
      aria-label="Saved view actions"
      onKeyDown={onMenuKeyDown}
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
    </FloatingPortalSurface>
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
  const { dialogRef, onKeyDown } = useModalDialog({
    open: true,
    onClose: onCancel,
    initialFocusRef: ref,
  });
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
    // Backdrop clicks are a pointer convenience; Escape and Cancel are the
    // equivalent keyboard paths managed by useModalDialog.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="saved-view-save-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape/focus-trap keys bubble from dialog controls. */}
      <div
        ref={dialogRef}
        className="saved-view-save-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Save current view"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h4>Save current view</h4>
        <label className="saved-view-save-field">
          <span className="saved-view-save-field-label">Name</span>
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

        <fieldset className="saved-view-visibility-fieldset">
          <legend className="saved-view-save-field-label">Who can see this</legend>
          <div className="saved-view-visibility-options" role="radiogroup" aria-label="Who can see this view">
            <label
              aria-label="Personal (only me)"
              className={`saved-view-visibility-option${
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
              <span className="saved-view-visibility-option-text">
                <span className="saved-view-visibility-option-title">Personal (only me)</span>
                <span className="saved-view-visibility-option-hint">
                  Saved to your account; teammates won't see it.
                </span>
              </span>
            </label>

            <label
              aria-label="Shared with the team"
              className={`saved-view-visibility-option${
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
              <span className="saved-view-visibility-option-text">
                <span className="saved-view-visibility-option-title">Shared (team)</span>
                <span className="saved-view-visibility-option-hint">
                  {canSaveShared
                    ? "Everyone in this workspace can open it."
                    : "Needs edit access — viewers can only save personal views."}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="saved-view-save-modal-actions">
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

// One confirm affordance for any irreversible-or-broadcasting action (delete,
// propose). `tone` only swaps the accent on the confirm button — a warm danger
// for destructive actions, the brand primary for a benign-but-deliberate one
// like proposing — so the two flows stay visually consistent.
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
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, onClose: onCancel });
  return (
    // Backdrop clicks are a pointer convenience; Escape and Cancel are the
    // equivalent keyboard paths managed by useModalDialog.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="saved-view-confirm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape/focus-trap keys bubble from dialog controls. */}
      <div
        ref={dialogRef}
        className={`saved-view-confirm-modal saved-view-confirm-modal-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h4>{title}</h4>
        <p>{body}</p>
        <div className="saved-view-confirm-modal-actions">
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
