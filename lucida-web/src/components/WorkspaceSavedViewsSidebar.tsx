import {
  ArrowsClockwiseIcon,
  CheckIcon,
  DotsThreeIcon,
  LinkIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  TrashIcon,
  ArrowUUpLeftIcon,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { relativeTimeFromIso } from "../savedView/useBookmarks.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { Switch } from "../ui/Switch.tsx";
import { SearchField, TextField } from "../ui/TextField.tsx";
import {
  defaultWorkspaceSavedViewName,
  useWorkspaceSavedViews,
  type WorkspaceSavedView,
  type WorkspaceSavedViewVisibility,
} from "../savedView/useWorkspaceSavedViews.ts";
import type { SavedView } from "../savedView/types.ts";
import { rightPanelOpenPreference, rightPanelPreference } from "../shell/layoutPreferences.ts";
import { setPreference } from "../theme/preferences.ts";
import { useCommand } from "../ui/commands.ts";
import { dismissToast, toast } from "../ui/toastQueue.ts";
import "./BookmarkSidebar.css";
import "./WorkspaceSavedViewsSidebar.css";

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
  visible: boolean;
}

function failed(title: string, e: unknown): void {
  toast({ title, description: e instanceof Error ? e.message : String(e), tone: "danger" });
}

interface ConfirmRequest {
  savedView: WorkspaceSavedView;
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
  // The prompt renders only while this panel shows, so the command opens it.
  useCommand({
    id: "views.save",
    label: "Save view…",
    group: "View",
    keywords: ["bookmark"],
    run: () => {
      setPreference(rightPanelPreference, "savedViews");
      setPreference(rightPanelOpenPreference, true);
      setSavePromptOpen(true);
    },
  });
  const [renameId, setRenameId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmRequest | null>(null);
  const [confirmPropose, setConfirmPropose] = useState<ConfirmRequest | null>(null);
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

  const renderRow = (view: WorkspaceSavedView, actions?: ReactNode) => (
    <SavedViewRow
      key={view.id}
      view={view}
      isRenaming={renameId === view.id}
      isDefault={defaultSavedViewId === view.id}
      isActive={currentOpenSavedViewId === view.id}
      onRenameCommit={(n) => handleRenameCommit(view.id, n)}
      onRenameCancel={() => setRenameId(null)}
      onOpen={() => void handleOpen(view)}
      menu={
        <SavedViewActionsMenu
          canEdit={canEdit}
          // Rename/Delete of your own view, except a shared one: those are
          // editor-only, and the server enforces it.
          isMine={isMine(view) && view.visibility !== "shared"}
          isDefault={defaultSavedViewId === view.id}
          canPromote={canPromoteToShared(view)}
          canPropose={canProposeToTeam(view)}
          canWithdraw={canWithdrawProposal(view)}
          onPromote={() => void handlePromote(view)}
          // Confirm first: proposing makes the view visible to every editor.
          onPropose={() => setConfirmPropose({ savedView: view })}
          onWithdraw={() => void handleWithdraw(view)}
          onRename={() => setRenameId(view.id)}
          onSetDefault={() => void handleSetDefault(view)}
          onReplace={() => void handleReplace(view)}
          onDelete={() => setConfirmDelete({ savedView: view })}
          onCopyLink={() => void handleCopyLink(view)}
        />
      }
      actions={actions}
    />
  );

  return (
    <section className="lc-rail-panel" aria-label="Saved views">
      <PanelHeader
        className="lc-rail-panel-header"
        title="Saved views"
        meta={savedViews.length > 0 ? savedViews.length : undefined}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={PlusIcon}
            onPress={() => setSavePromptOpen(true)}
          >
            Save view
          </Button>
        }
      />

      <div className="lc-rail-panel-toolbar">
        <SearchField
          label="Search saved views"
          placeholder="Search name or creator"
          value={filter.search}
          onChange={setSearch}
        />
        <Switch label="Mine only" isSelected={filter.mineOnly} onChange={setMineOnly} />
      </div>

      <div className="lc-rail-panel-body">
        {error && (
          <p className="lc-rail-panel-note" data-tone="danger" role="alert">
            Error: {error}
          </p>
        )}
        {isLoading && <p className="lc-rail-panel-note">Loading saved views…</p>}

        {reviewQueue.length > 0 && (
          <section className="lc-rail-panel-section" data-testid="saved-view-review-queue">
            <h3 className="lc-rail-panel-section-title">
              Proposed for review ({reviewQueue.length})
            </h3>
            <ul className="lc-rail-list">
              {reviewQueue.map((view) =>
                renderRow(
                  view,
                  <>
                    <Button
                      size="sm"
                      icon={CheckIcon}
                      data-testid={`saved-view-approve-${view.id}`}
                      onPress={() => void handleApprove(view)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      data-testid={`saved-view-reject-${view.id}`}
                      onPress={() => handleReject(view)}
                    >
                      Reject
                    </Button>
                  </>,
                ),
              )}
            </ul>
          </section>
        )}

        <section className="lc-rail-panel-section">
          {reviewQueue.length > 0 && mainList.length > 0 && (
            <h3 className="lc-rail-panel-section-title">Views</h3>
          )}
          <ul className="lc-rail-list">{mainList.map((view) => renderRow(view))}</ul>
          {showEmptyState && <p className="lc-rail-panel-empty">{emptyText}</p>}
        </section>
      </div>

      {savePromptOpen && (
        <SaveSavedViewDialog
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
        <ConfirmDialog
          tone="danger"
          title="Delete saved view?"
          confirmLabel="Delete"
          body={
            <>
              Delete <strong>{confirmDelete.savedView.name}</strong>? This can&rsquo;t be
              undone.
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.savedView)}
        />
      )}

      {confirmPropose && (
        <ConfirmDialog
          tone="primary"
          title="Propose to the team?"
          confirmLabel="Propose to team"
          confirmTestId="saved-view-propose-confirm"
          body={
            <>
              Propose <strong>{confirmPropose.savedView.name}</strong> to the team? Every
              editor sees it in their review queue and can approve it to share it with the
              whole workspace.
            </>
          }
          onCancel={() => setConfirmPropose(null)}
          onConfirm={() => void handlePropose(confirmPropose.savedView)}
        />
      )}

    </section>
  );
}

const VISIBILITY_CHIP: Record<
  WorkspaceSavedView["visibility"],
  { label: string; title: string; tone: "neutral" | "warning" } | null
> = {
  shared: null,
  personal: { label: "Personal", title: "Only you can see this saved view", tone: "neutral" },
  proposed: {
    label: "Proposed",
    title: "Pending: proposed to the team, awaiting an editor's review",
    tone: "warning",
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
  menu,
  actions,
}: {
  view: WorkspaceSavedView;
  isRenaming: boolean;
  isDefault: boolean;
  isActive: boolean;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onOpen: () => void;
  menu: ReactNode;
  actions?: ReactNode;
}) {
  const chip = VISIBILITY_CHIP[view.visibility];
  const updated = relativeTimeFromIso(view.updated_at);
  const meta = [view.created_by_name || view.created_by, updated, isDefault ? "default" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className="lc-rail-row"
      data-testid="saved-view-row"
      data-visibility={view.visibility}
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
    >
      <div className="lc-rail-row-line">
        {isRenaming ? (
          <RenameField initial={view.name} onCommit={onRenameCommit} onCancel={onRenameCancel} />
        ) : (
          <button type="button" className="lc-rail-row-open" onClick={onOpen} title={view.name}>
            <span className="lc-rail-row-text">
              <span className="lc-rail-row-title">
                <span className="lc-rail-row-name">{view.name}</span>
                {isDefault && (
                  <PushPinIcon className="lc-saved-view-default" size={12} weight="fill" aria-label="Default view" />
                )}
                {chip && (
                  <span
                    className="lc-saved-view-chip"
                    data-testid={`saved-view-visibility-${view.id}`}
                    title={chip.title}
                  >
                    <Badge tone={chip.tone}>{chip.label}</Badge>
                  </span>
                )}
              </span>
              <span className="lc-rail-row-meta">{meta}</span>
            </span>
          </button>
        )}
        <div className="lc-rail-row-trailing">{menu}</div>
      </div>
      {actions && <div className="lc-rail-row-actions">{actions}</div>}
    </li>
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

function RenameField({
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
  // Escape cancels, and the blur that follows must not commit the draft.
  const cancelled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="lc-saved-view-rename">
      <TextField
        label="Saved view name"
        labelPosition="hidden"
        value={value}
        onChange={setValue}
        inputRef={ref}
        data-testid="saved-view-rename-input"
        onBlur={() => {
          if (!cancelled.current) onCommit(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            onCancel();
          }
        }}
      />
    </div>
  );
}

function SavedViewActionsMenu({
  canEdit,
  isMine,
  isDefault,
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
  canEdit: boolean;
  isMine: boolean;
  isDefault: boolean;
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
    <Menu
      label="Saved view actions"
      placement="bottom end"
      trigger={
        <IconButton icon={DotsThreeIcon} label="Saved view actions" size="sm" tooltipPlacement="left" />
      }
    >
      <MenuItem icon={LinkIcon} onAction={onCopyLink}>
        Copy view link
      </MenuItem>
      {canPromote && (
        <MenuItem icon={ShareNetworkIcon} onAction={onPromote}>
          Share with team
        </MenuItem>
      )}
      {canPropose && (
        <MenuItem icon={PaperPlaneTiltIcon} onAction={onPropose}>
          Propose to team
        </MenuItem>
      )}
      {canWithdraw && (
        <MenuItem icon={ArrowUUpLeftIcon} onAction={onWithdraw}>
          Withdraw proposal
        </MenuItem>
      )}
      {canEdit && (
        <MenuItem icon={isDefault ? PushPinSlashIcon : PushPinIcon} onAction={onSetDefault}>
          {isDefault ? "Clear default" : "Set as default"}
        </MenuItem>
      )}
      {canEdit && (
        <MenuItem icon={ArrowsClockwiseIcon} onAction={onReplace}>
          Update from current view
        </MenuItem>
      )}
      {canManageOwn && (
        <MenuItem icon={PencilSimpleIcon} onAction={onRename}>
          Rename
        </MenuItem>
      )}
      {canManageOwn && (
        <MenuItem icon={TrashIcon} variant="danger" onAction={onDelete}>
          Delete
        </MenuItem>
      )}
    </Menu>
  );
}

function SaveSavedViewDialog({
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
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.select();
  }, []);

  const trimmed = name.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    onSave(trimmed, visibility);
  };

  const options: {
    value: WorkspaceSavedViewVisibility;
    title: string;
    hint: string;
    disabled?: boolean;
  }[] = [
    {
      value: "personal",
      title: "Personal",
      hint: "Saved to your account. Teammates won't see it.",
    },
    {
      value: "shared",
      title: "Shared with the team",
      hint: canSaveShared
        ? "Everyone in this workspace can open it."
        : "Needs edit access. Viewers can save personal views only.",
      disabled: !canSaveShared,
    },
  ];

  return (
    <Dialog
      title="Save current view"
      size="sm"
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      footer={
        <>
          <Button onPress={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="saved-view-save-confirm"
            isDisabled={trimmed.length === 0}
            onPress={submit}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="lc-saved-view-form">
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          autoFocus
          inputRef={nameRef}
          data-testid="saved-view-name-input"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <fieldset className="lc-saved-view-visibility">
          <legend className="lc-saved-view-visibility-legend">Who can see this</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className="lc-saved-view-visibility-option"
              data-selected={visibility === option.value || undefined}
              data-disabled={option.disabled || undefined}
            >
              <input
                type="radio"
                name="saved-view-visibility"
                data-testid={`visibility-${option.value}`}
                value={option.value}
                checked={visibility === option.value}
                disabled={option.disabled}
                onChange={() => setVisibility(option.value)}
              />
              <span className="lc-saved-view-visibility-text">
                <span className="lc-saved-view-visibility-title">{option.title}</span>
                <span className="lc-saved-view-visibility-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}

// One confirm dialog for irreversible or broadcasting actions (delete, propose).
// `tone` only swaps the confirm button: danger for destructive actions, primary
// for deliberate ones like proposing.
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone,
  confirmTestId,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone: "danger" | "primary";
  confirmTestId?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={title}
      size="sm"
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      footer={
        <>
          {/* A destructive confirm starts on Cancel, so a stray Enter never deletes. */}
          <Button onPress={onCancel} autoFocus={tone === "danger"}>
            Cancel
          </Button>
          <Button
            variant={tone}
            data-testid={confirmTestId}
            onPress={onConfirm}
            autoFocus={tone !== "danger"}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="lc-saved-view-confirm">{body}</p>
    </Dialog>
  );
}
